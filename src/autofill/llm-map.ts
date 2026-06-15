/**
 * Map page form fields to resume data using the on-device LLM.
 *
 * Runs in the offscreen document (where WebGPU + a worker are available). It is
 * deliberately conservative: the model may only use facts from the resume and
 * must omit anything it isn't sure about. Falls back to an empty map (engine
 * "none") whenever WebGPU/the model isn't usable.
 */
import type { FieldForLlm, MapFieldsResponse } from "../lib/messaging.js";
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
): Promise<MapFieldsResponse> {
  if (fields.length === 0) return { map: {}, engine: "none", note: "no fields" };

  const engine = new WebLLMEngine(model);
  if (!(await engine.isAvailable())) {
    engine.dispose();
    return { map: {}, engine: "none", note: "WebGPU/model unavailable" };
  }

  let raw = "";
  try {
    raw = await engine.generate(buildPrompt(resume, fields), { maxTokens: 800, temperature, json: true });
  } catch (e) {
    log.warn("field mapping failed", e);
    engine.dispose();
    return { map: {}, engine: "none", note: e instanceof Error ? e.message : String(e) };
  }
  engine.dispose();

  return { map: parseMap(raw, fields), engine: "webllm" };
}

function buildPrompt(resume: ResumeData, fields: FieldForLlm[]): ChatMessage[] {
  const exp = resume.experiences[0];
  const profile = [
    resume.fullName && `Name: ${resume.fullName}`,
    resume.email && `Email: ${resume.email}`,
    resume.phone && `Phone: ${resume.phone}`,
    resume.location && `Location: ${resume.location}`,
    resume.links.length && `Links: ${resume.links.map((l) => `${l.label} ${l.url}`).join(", ")}`,
    resume.skills.length && `Skills: ${resume.skills.join(", ")}`,
    exp && `Current role: ${exp.title} at ${exp.company}`,
    resume.summary && `Summary: ${resume.summary}`,
  ]
    .filter(Boolean)
    .join("\n");

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
        "You fill job-application form fields from a candidate's resume. For each field, choose the " +
        "best value using ONLY the resume data given. If a field has options, pick the closest option " +
        "text verbatim. If you don't know or it doesn't apply, OMIT that field. Never invent data " +
        '(no fake numbers, addresses, or dates). Respond with ONLY a JSON object mapping ref -> value, ' +
        'e.g. {"f0":"Jane Doe","f2":"5"}. No commentary, no code fences.',
    },
    {
      role: "user",
      content: `Resume:\n${profile}\n\nFields to fill:\n${fieldList}\n\nJSON:`,
    },
  ];
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
