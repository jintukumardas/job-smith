/**
 * Page-side WebLLM engine. Spawns the dedicated worker, drives model loading and
 * generation over the typed protocol, and exposes the {@link ResumeEngine} API.
 *
 * Privacy: prompts (which include your resume + the JD) are posted only to the
 * local worker. No network calls carry your data — only the model download does,
 * and that download contains no personal data.
 */
import type { ResumeEngine, TailorRequest, EngineTailorResult, TailoredContent } from "./engine.js";
import { identityFrom, serializeResumeForLlm } from "./engine.js";
import type { ResumeEducation, ResumeExperience, ResumeSection } from "../types/index.js";
import type { ChatMessage, LlmFromWorker, LlmToWorker } from "./llm-protocol.js";
import { LLM_WORKER_FILE } from "./llm-protocol.js";
import { uid } from "../lib/util.js";
import { createLogger } from "../lib/logger.js";

interface Pending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
  onProgress?: (progress: number, text: string) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** If set, the timeout is an IDLE timeout reset on every progress event. */
  idleMs?: number;
}

const RESUME_MAX_TOKENS = 2048;
// Bound generation; the model download (init) uses an idle timeout reset by
// progress events so a slow-but-advancing download is never killed.
const CHAT_TIMEOUT_MS = 240_000;
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
    req.onProgress?.({ phase: "loading-model", progress: 0, message: "Loading on-device model…" });
    await this.init((progress, text) =>
      req.onProgress?.({ phase: "loading-model", progress, message: text }),
    );

    req.onProgress?.({ phase: "generating", message: "Writing your tailored resume…" });
    const source = serializeResumeForLlm(req.resume);
    const raw = await this.chat(
      buildResumePrompt(source, req),
      Math.min(req.temperature, 0.35),
      RESUME_MAX_TOKENS,
      true, // JSON-constrained
    );
    const parsed = parseResumeJson(raw);
    if (!parsed) throw new Error("the model did not return a usable resume");

    const content: TailoredContent = {
      ...identityFrom(req.resume),
      summary: parsed.summary || req.resume.summary,
      skills: parsed.skills.length ? parsed.skills : req.resume.skills,
      experiences: parsed.experiences.length ? parsed.experiences : req.resume.experiences,
      education: parsed.education.length ? parsed.education : req.resume.education,
      extraSections: parsed.sections.length ? parsed.sections : req.resume.extraSections ?? [],
    };

    req.onProgress?.({ phase: "done" });
    return {
      content,
      notes: [`Written on-device with ${this.model} (WebLLM) — nothing left your machine.`],
    };
  }

  /** Generic single-shot generation (used by the autofill field mapper). */
  async generate(
    messages: ChatMessage[],
    opts: {
      maxTokens: number;
      temperature: number;
      json?: boolean;
      onProgress?: (p: number, t: string) => void;
    },
  ): Promise<string> {
    await this.init(opts.onProgress);
    return this.chat(messages, opts.temperature, opts.maxTokens, opts.json ?? false);
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

  private chat(
    messages: ChatMessage[],
    temperature: number,
    maxTokens: number,
    json = false,
  ): Promise<string> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.arm(id, CHAT_TIMEOUT_MS);
      worker.postMessage({
        id,
        type: "chat",
        messages,
        temperature,
        maxTokens,
        ...(json ? { json: true } : {}),
      } satisfies LlmToWorker);
    });
  }

}

/* ----------------------------- prompt + parsing -------------------------- */

const RESUME_SCHEMA = `{
  "summary": "2-3 sentence professional summary tailored to the job",
  "skills": ["ALL of the candidate's skills from the source, most relevant first"],
  "experiences": [
    {"title": "", "company": "", "startDate": "", "endDate": "", "location": "", "bullets": ["rephrased achievement from the source"]}
  ],
  "education": [{"degree": "", "institution": "", "year": ""}],
  "sections": [{"heading": "Achievements", "items": ["from the source"]}]
}`;

function buildResumePrompt(source: string, req: TailorRequest): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are an expert resume writer. Rewrite the candidate's resume tailored to the TARGET JOB. " +
        "STRICT RULES: use ONLY facts found in the SOURCE RESUME — never invent companies, titles, dates, " +
        "degrees, numbers/metrics, or skills. You may rephrase bullets and reorder/select content to " +
        "emphasize what matches the job, but every fact must come from the source. Do NOT add skills the " +
        "candidate does not have. Include the candidate's FULL skill list and ALL relevant sections from the " +
        "source (achievements, projects, certifications, etc.) under \"sections\". Reply with ONLY a JSON object " +
        "in exactly this shape — no markdown, no code fences, no commentary:\n" +
        RESUME_SCHEMA,
    },
    {
      role: "user",
      content:
        `TARGET JOB:\n${req.jd.slice(0, 3000)}\n\n` +
        `Skills this job values: ${req.analysis.skills.slice(0, 15).join(", ") || "n/a"}\n` +
        `Do NOT claim these (the candidate lacks them): ${req.missingSkills.join(", ") || "none"}\n\n` +
        `SOURCE RESUME:\n${source}\n\nJSON:`,
    },
  ];
}

interface ParsedResumeJson {
  summary: string;
  skills: string[];
  experiences: ResumeExperience[];
  education: ResumeEducation[];
  sections: ResumeSection[];
}

function parseResumeJson(raw: string): ParsedResumeJson | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const summary = str(obj.summary);
  const skills = Array.isArray(obj.skills)
    ? obj.skills.map(str).filter(Boolean).slice(0, 30)
    : [];
  const experiences = Array.isArray(obj.experiences)
    ? obj.experiences.map(toExperience).filter((e) => e.title || e.company || e.bullets.length > 0).slice(0, 12)
    : [];
  const education = Array.isArray(obj.education)
    ? obj.education.map(toEducation).filter((e) => e.institution || e.degree).slice(0, 6)
    : [];
  const sections = Array.isArray(obj.sections)
    ? obj.sections.map(toSection).filter((s) => s.heading && s.items.length > 0).slice(0, 8)
    : [];

  if (!summary && experiences.length === 0 && skills.length === 0) return null;
  return { summary, skills, experiences, education, sections };
}

function toSection(o: unknown): ResumeSection {
  const r = (o ?? {}) as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items.map(str).filter(Boolean).slice(0, 20) : [];
  return { heading: str(r.heading), items };
}

function toExperience(o: unknown): ResumeExperience {
  const r = (o ?? {}) as Record<string, unknown>;
  const bullets = Array.isArray(r.bullets) ? r.bullets.map(str).filter(Boolean).slice(0, 12) : [];
  const exp: ResumeExperience = { id: uid("exp"), company: str(r.company), title: str(r.title), bullets, skills: [] };
  if (str(r.startDate)) exp.startDate = str(r.startDate);
  if (str(r.endDate)) exp.endDate = str(r.endDate);
  if (str(r.location)) exp.location = str(r.location);
  return exp;
}

function toEducation(o: unknown): ResumeEducation {
  const r = (o ?? {}) as Record<string, unknown>;
  const edu: ResumeEducation = { institution: str(r.institution) };
  if (str(r.degree)) edu.degree = str(r.degree);
  if (str(r.year)) edu.year = str(r.year);
  return edu;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
