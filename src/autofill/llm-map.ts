/**
 * Map page form fields to resume data using the on-device LLM.
 *
 * Runs in the offscreen document (where WebGPU + a worker are available). It is
 * deliberately conservative: the model may only use facts from the resume and
 * must omit anything it isn't sure about. Falls back to an empty map (engine
 * "none") whenever WebGPU/the model isn't usable.
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

  let raw = "";
  try {
    raw = await engine.generate(buildPrompt(resume, fields, jd), {
      maxTokens: 900,
      temperature,
      json: true,
      onProgress: (progress, text) => {
        // progress < 1 → still downloading/initialising the model.
        if (progress >= 1) {
          onProgress?.({ type: "MAP_PROGRESS", phase: "generating", message: "Reading the page and filling fields…" });
        } else {
          onProgress?.({
            type: "MAP_PROGRESS",
            phase: "loading-model",
            progress,
            message: text || `Downloading AI model… ${Math.round(progress * 100)}%`,
          });
        }
      },
    });
  } catch (e) {
    log.warn("field mapping failed", e);
    engine.dispose();
    return { map: {}, engine: "none", note: e instanceof Error ? e.message : String(e) };
  }
  engine.dispose();

  return { map: parseMap(raw, fields), engine: "webllm" };
}

function buildPrompt(resume: ResumeData, fields: FieldForLlm[], jd?: JdContext): ChatMessage[] {
  const profile = [
    resume.fullName && `Name: ${resume.fullName}`,
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

  const role = jd ? roleOverview(jd) : "";

  const fieldList = fields
    .map((f) => {
      const opts = f.options?.length ? ` | options: ${f.options.join(" / ")}` : "";
      return `- ref "${f.ref}": ${f.label} (type: ${f.type})${opts}`;
    })
    .join("\n");

  return [
    {
      role: "system",
      content:
        "You fill a job-application form from a candidate's resume and the job posting they are applying to. " +
        "Rules:\n" +
        "1. For short fields (name, email, location, years, links), use ONLY facts from the resume. " +
        "Never invent numbers, addresses, dates, employers, or credentials.\n" +
        "2. If a field lists options, pick the closest option text VERBATIM.\n" +
        "3. For open-ended fields (textarea / cover letter / 'why are you interested' / 'describe your experience'), " +
        "write a concise, truthful 2-4 sentence answer grounded in the resume and tailored to the JOB POSTING. " +
        "Only reference skills and experience the candidate actually has.\n" +
        "4. If a field doesn't apply or you can't ground it in the resume, OMIT it.\n" +
        'Respond with ONLY a JSON object mapping ref -> value, e.g. {"f0":"Jane Doe","f2":"5"}. ' +
        "No commentary, no code fences.",
    },
    {
      role: "user",
      content:
        `RESUME:\n${profile}\n\n` +
        (role ? `${role}\n\n` : "") +
        `FIELDS TO FILL:\n${fieldList}\n\nJSON:`,
    },
  ];
}

/** A couple of recent roles with a few bullets, to ground open-ended answers. */
function experienceLines(resume: ResumeData): string {
  const lines = resume.experiences.slice(0, 2).map((e) => {
    const head = [e.title, e.company].filter(Boolean).join(" at ");
    const bullets = e.bullets.slice(0, 3).map((b) => `  • ${b}`).join("\n");
    return bullets ? `Experience: ${head}\n${bullets}` : `Experience: ${head}`;
  });
  return lines.join("\n");
}

function roleOverview(jd: JdContext): string {
  const header = [jd.title && `Title: ${jd.title}`, jd.company && `Company: ${jd.company}`]
    .filter(Boolean)
    .join(" | ");
  const body = jd.text.trim().slice(0, 1800);
  if (!header && !body) return "";
  return `JOB POSTING (the role they are applying to):\n${[header, body].filter(Boolean).join("\n")}`;
}

/** Robustly extract a ref->value object from the model's raw text. */
export function parseMap(raw: string, fields: FieldForLlm[]): Record<string, string> {
  const valid = new Set(fields.map((f) => f.ref));
  const out: Record<string, string> = {};
  const obj = extractJsonObject(raw);
  if (!obj) return out;
  for (const [ref, value] of Object.entries(obj)) {
    if (!valid.has(ref)) continue;
    const v = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
    if (!v || /^(null|n\/a|none|unknown)$/i.test(v)) continue;
    out[ref] = v;
  }
  return out;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
