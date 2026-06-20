/**
 * Map page form fields to resume data using the on-device LLM.
 *
 * Runs in the offscreen document (where WebGPU + a worker are available). Each
 * field is answered INDIVIDUALLY as plain text — not as one big JSON map — because
 * small on-device models reliably mangle JSON when the values are long, multi-
 * sentence answers (quotes/newlines). One model load is reused across all fields.
 *
 * It is truthful by construction: the prompt forbids inventing facts or inflating
 * seniority; selects are matched back to a real option; "SKIP" answers are dropped.
 */
import type { FieldForLlm, JdContext, MapFieldsResponse, MapProgress } from "../lib/messaging.js";
import type { ResumeData } from "../types/index.js";
import type { ChatMessage } from "../resume/llm-protocol.js";
import { WebLLMEngine } from "../resume/webllm.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("llm-map");

export async function mapFieldsWithLlm(
  resume: ResumeData,
  fields: FieldForLlm[],
  model: string,
  temperature: number,
  jd?: JdContext,
  onProgress?: (p: MapProgress) => void,
): Promise<MapFieldsResponse> {
  if (fields.length === 0) return { map: {}, engine: "none", note: "no fields" };

  const engine = new WebLLMEngine(model);
  if (!(await engine.isAvailable())) {
    engine.dispose();
    return { map: {}, engine: "none", note: "WebGPU unavailable in this browser/GPU" };
  }

  onProgress?.({ type: "MAP_PROGRESS", phase: "loading-model", message: "Loading on-device AI…" });

  const profile = buildProfile(resume);
  const role = jd ? roleOverview(jd) : "";
  const map: Record<string, string> = {};
  let lastError: string | undefined;

  const announce = (i: number, field: FieldForLlm): void =>
    onProgress?.({
      type: "MAP_PROGRESS",
      phase: "generating",
      message: `Answering ${i + 1} of ${fields.length}: ${trimLabel(field.label)}`,
    });

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (i > 0) announce(i, field); // model is warm; announce before generating
    try {
      const answer = await engine.generate(buildFieldPrompt(profile, role, field), {
        maxTokens: maxTokensFor(field),
        temperature: Math.min(temperature, isOpenEnded(field) ? 0.6 : 0.2),
        // Only the FIRST field can trigger the (one-time) model download; surface
        // its progress, then flip to "answering 1 of N" when the weights are ready.
        onProgress:
          i === 0
            ? (progress, text) => {
                if (progress < 1) {
                  onProgress?.({
                    type: "MAP_PROGRESS",
                    phase: "loading-model",
                    progress,
                    message: text || `Downloading AI model… ${Math.round(progress * 100)}%`,
                  });
                } else {
                  announce(0, field);
                }
              }
            : undefined,
      });
      const cleaned = cleanAnswer(answer, field);
      if (cleaned) map[field.ref] = cleaned;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      log.warn(`field "${field.label}" failed`, e);
    }
  }

  engine.dispose();
  if (Object.keys(map).length === 0 && lastError) {
    return { map: {}, engine: "none", note: lastError };
  }
  return { map, engine: "webllm" };
}

/* -------------------------------- prompts -------------------------------- */

function buildFieldPrompt(profile: string, role: string, field: FieldForLlm): ChatMessage[] {
  const select = field.options?.length
    ? `This field is a dropdown. Choose EXACTLY ONE of these options and reply with that option's text only:\nOptions: ${field.options.join(" | ")}`
    : isOpenEnded(field)
      ? "Write a concise, specific answer in the first person (2-5 sentences). Ground every claim in the candidate's REAL experience and the job posting. Do not invent skills, employers, metrics, or inflate seniority."
      : "Reply with a short, direct value (a few words) taken from the résumé.";

  return [
    {
      role: "system",
      content:
        "You complete ONE field of a job application on the candidate's behalf, truthfully. " +
        "Use ONLY facts from the candidate's résumé and the job posting below. Never fabricate or " +
        "inflate (no invented skills/employers/metrics, no upgraded seniority or titles). " +
        "Output ONLY the answer text for this one field — no field name, no quotes, no JSON, no notes. " +
        "If you genuinely cannot answer it from the résumé, reply with exactly: SKIP",
    },
    {
      role: "user",
      content:
        `CANDIDATE RÉSUMÉ:\n${profile}\n\n` +
        (role ? `${role}\n\n` : "") +
        `FORM FIELD:\n"${field.label}"\n\n${select}\n\nAnswer:`,
    },
  ];
}

function buildProfile(resume: ResumeData): string {
  return [
    resume.fullName && `Name: ${resume.fullName}`,
    resume.headline && `Title: ${resume.headline}`,
    resume.email && `Email: ${resume.email}`,
    resume.phone && `Phone: ${resume.phone}`,
    resume.location && `Location: ${resume.location}`,
    resume.links.length && `Links: ${resume.links.map((l) => `${l.label} ${l.url}`).join(", ")}`,
    resume.skills.length && `Skills: ${resume.skills.join(", ")}`,
    resume.summary && `Summary: ${resume.summary}`,
    experienceLines(resume),
  ]
    .filter(Boolean)
    .join("\n");
}

function experienceLines(resume: ResumeData): string {
  return resume.experiences
    .slice(0, 3)
    .map((e) => {
      const head = [e.title, e.company].filter(Boolean).join(" at ");
      const bullets = e.bullets.slice(0, 3).map((b) => `  • ${b}`).join("\n");
      return bullets ? `Experience: ${head}\n${bullets}` : `Experience: ${head}`;
    })
    .join("\n");
}

function roleOverview(jd: JdContext): string {
  const header = [jd.title && `Title: ${jd.title}`, jd.company && `Company: ${jd.company}`]
    .filter(Boolean)
    .join(" | ");
  const body = jd.text.trim().slice(0, 1800);
  if (!header && !body) return "";
  return `JOB POSTING (the role they are applying to):\n${[header, body].filter(Boolean).join("\n")}`;
}

/* ------------------------------- answers --------------------------------- */

/** Open-ended = a textarea, a question, or a label that asks for prose. */
export function isOpenEnded(field: FieldForLlm): boolean {
  if (field.options?.length) return false;
  if (field.type === "textarea") return true;
  return (
    field.label.length > 70 ||
    /\?|why|describe|tell us|explain|cover letter|what\b|how\b|reason|interest|motivat|feel free|list (any|other|additional|them|your|relevant)|elaborate|in your own words|about you/i.test(
      field.label,
    )
  );
}

function maxTokensFor(field: FieldForLlm): number {
  if (field.options?.length) return 24;
  if (isOpenEnded(field)) return 320;
  return 48;
}

/** Clean a single field's answer; for selects, resolve to a real option. */
export function cleanAnswer(raw: string, field: FieldForLlm): string {
  let t = raw.replace(/```[a-z]*\n?/gi, "").trim();
  t = t.replace(/^\s*(answer|response|value)\s*[:\-–]\s*/i, "").trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  if (!t || /^(skip|n\/?a|none|null|unknown|i (don'?t|do not) know)\.?$/i.test(t)) return "";

  if (field.options?.length) {
    const lower = t.toLowerCase();
    const exact = field.options.find((o) => o.toLowerCase() === lower);
    const partial = field.options.find(
      (o) => lower.includes(o.toLowerCase()) || o.toLowerCase().includes(lower),
    );
    return exact ?? partial ?? "";
  }

  const cap = isOpenEnded(field) ? 1500 : 160;
  return t.slice(0, cap).trim();
}

function trimLabel(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
}
