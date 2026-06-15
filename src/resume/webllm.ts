/**
 * Page-side WebLLM engine. Spawns the dedicated worker, drives model loading and
 * generation over the typed protocol, and exposes the {@link ResumeEngine} API.
 *
 * Privacy: prompts (which include your resume + the JD) are posted only to the
 * local worker. No network calls carry your data — only the model download does,
 * and that download contains no personal data.
 */
import type { ResumeEngine, TailorRequest, EngineTailorResult } from "./engine.js";
import { summarizeExperiences } from "./engine.js";
import type { ChatMessage, LlmFromWorker, LlmToWorker } from "./llm-protocol.js";
import { LLM_WORKER_FILE } from "./llm-protocol.js";
import { createLogger } from "../lib/logger.js";

interface Pending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number, text: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** If set, the timeout is an IDLE timeout reset on every progress event. */
  idleMs?: number;
}

const SUMMARY_MAX_TOKENS = 240;
const BULLETS_MAX_TOKENS = 420;
// Bound generation; the model download (init) uses an idle timeout reset by
// progress events so a slow-but-advancing download is never killed.
const CHAT_TIMEOUT_MS = 180_000;
const INIT_IDLE_TIMEOUT_MS = 180_000;

export class WebLLMEngine implements ResumeEngine {
  readonly kind = "webllm" as const;

  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initPromise: Promise<string> | null = null;
  private readonly log = createLogger("webllm");

  constructor(private readonly model: string) {}

  async isAvailable(): Promise<boolean> {
    const gpu =
      typeof navigator !== "undefined"
        ? (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
        : undefined;
    const hasWorker = typeof Worker !== "undefined";
    const hasRuntime =
      typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.getURL;
    if (!gpu || !hasWorker || !hasRuntime) return false;
    // navigator.gpu can exist while no usable adapter is available (blocklisted
    // GPU, software rendering, headless). Probe a real adapter before committing.
    try {
      const adapter = await gpu.requestAdapter();
      return adapter != null;
    } catch {
      return false;
    }
  }

  async tailor(req: TailorRequest): Promise<EngineTailorResult> {
    const notes: string[] = [];
    req.onProgress?.({ phase: "loading-model", progress: 0, message: "Loading on-device model…" });
    await this.init((progress, text) =>
      req.onProgress?.({ phase: "loading-model", progress, message: text }),
    );

    req.onProgress?.({ phase: "generating", message: "Writing a tailored summary…" });
    const summary = sanitize(await this.generateSummary(req));

    req.onProgress?.({ phase: "generating", message: "Rephrasing your most recent role…" });
    const bullets = await this.rewriteTopExperience(req);

    req.onProgress?.({ phase: "done" });
    notes.push(`Generated on-device with ${this.model} (WebLLM) — nothing left your machine.`);
    return { summary, bullets, notes };
  }

  /** Generic single-shot generation (used by the autofill field mapper). */
  async generate(
    messages: ChatMessage[],
    opts: { maxTokens: number; temperature: number; onProgress?: (p: number, t: string) => void },
  ): Promise<string> {
    await this.init(opts.onProgress);
    return this.chat(messages, opts.temperature, opts.maxTokens);
  }

  dispose(): void {
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("engine disposed"));
    }
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.initPromise = null;
  }

  /* ------------------------------ internals ------------------------------ */

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const url = chrome.runtime.getURL(LLM_WORKER_FILE);
    const worker = new Worker(url);
    worker.onmessage = (ev: MessageEvent<LlmFromWorker>) => this.handle(ev.data);
    worker.onerror = (ev: ErrorEvent) => {
      const err = new Error(`WebLLM worker error: ${ev.message || "unknown"}`);
      this.log.error("worker error", err.message);
      for (const p of this.pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.initPromise = null;
      // Drop the broken worker so the next call rebuilds a fresh one (self-heal).
      this.worker?.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  /** Arm (or reset) a per-request timeout. */
  private arm(id: number, ms: number): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const e = this.pending.get(id);
      if (!e) return;
      this.pending.delete(id);
      e.reject(new Error("WebLLM timed out waiting for the model worker"));
    }, ms);
  }

  private handle(msg: LlmFromWorker): void {
    const entry = this.pending.get(msg.id);
    if (msg.type === "progress") {
      entry?.onProgress?.(msg.progress, msg.text);
      if (entry?.idleMs) this.arm(msg.id, entry.idleMs); // reset the idle timeout
      return;
    }
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(msg.id);
    if (msg.type === "ready") entry.resolve("");
    else if (msg.type === "result") entry.resolve(msg.content);
    else entry.reject(new Error(msg.error));
  }

  private init(onProgress?: (p: number, t: string) => void): Promise<string> {
    if (this.initPromise) return this.initPromise;
    const worker = this.ensureWorker();
    const id = this.nextId++;
    this.initPromise = new Promise<string>((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        idleMs: INIT_IDLE_TIMEOUT_MS,
        ...(onProgress ? { onProgress } : {}),
      });
      this.arm(id, INIT_IDLE_TIMEOUT_MS);
      worker.postMessage({ id, type: "init", model: this.model } satisfies LlmToWorker);
    }).catch((err) => {
      this.initPromise = null; // allow retry after a failure
      throw err;
    });
    return this.initPromise;
  }

  private chat(messages: ChatMessage[], temperature: number, maxTokens: number): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.arm(id, CHAT_TIMEOUT_MS);
      worker.postMessage({ id, type: "chat", messages, temperature, maxTokens } satisfies LlmToWorker);
    });
  }

  private async generateSummary(req: TailorRequest): Promise<string> {
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a professional resume writer. Write a concise 2-3 sentence professional " +
          "summary tailored to the target role. CRITICAL: use ONLY facts present in the " +
          "candidate's data. Never invent employers, titles, metrics, or skills. Output plain " +
          "text only — no headings, no markdown, no preamble.",
      },
      {
        role: "user",
        content: [
          `Target role: ${req.analysis.role ?? "Software Engineer"}`,
          req.analysis.seniority ? `Seniority: ${req.analysis.seniority}` : "",
          `Skills this job values: ${req.analysis.skills.slice(0, 12).join(", ") || "n/a"}`,
          `Candidate's matching skills: ${req.matchedSkills.join(", ") || "n/a"}`,
          "",
          "Candidate data:",
          req.resume.headline ? `Headline: ${req.resume.headline}` : "",
          req.resume.summary ? `Existing summary: ${req.resume.summary}` : "",
          `Skills: ${req.resume.skills.join(", ") || "n/a"}`,
          "Experience:",
          summarizeExperiences(req.resume, 4),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
    return this.chat(messages, req.temperature, SUMMARY_MAX_TOKENS);
  }

  private async rewriteTopExperience(
    req: TailorRequest,
  ): Promise<Record<string, string[]> | undefined> {
    const exp = req.resume.experiences[0];
    if (!exp || exp.bullets.length === 0) return undefined;
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You rewrite resume bullet points to emphasize relevance to a target role while " +
          "staying strictly truthful. Rules: keep every original achievement and any numbers " +
          "exactly; do NOT add new metrics or claims; start each bullet with a strong past-tense " +
          "verb; surface technologies the job values when they genuinely appear. Output ONLY the " +
          "rewritten bullets, one per line, each starting with '- '. No commentary.",
      },
      {
        role: "user",
        content: [
          `Target role: ${req.analysis.role ?? "Software Engineer"}`,
          `Technologies the job values: ${req.analysis.skills.slice(0, 12).join(", ") || "n/a"}`,
          `Role: ${exp.title} at ${exp.company}`,
          "Original bullets:",
          ...exp.bullets.map((b) => `- ${b}`),
        ].join("\n"),
      },
    ];
    try {
      const raw = await this.chat(messages, req.temperature, BULLETS_MAX_TOKENS);
      const parsed = parseBullets(raw);
      if (parsed.length === 0) return undefined;
      return { [exp.id]: parsed };
    } catch (e) {
      this.log.warn("bullet rewrite failed; keeping originals", e);
      return undefined;
    }
  }
}

function parseBullets(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length >= 3 && l.length <= 320)
    .slice(0, 10);
}

function sanitize(text: string): string {
  return text.replace(/^\s*(summary|professional summary)\s*[:\-]\s*/i, "").trim();
}
