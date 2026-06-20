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
 *
 * Quality: the model sees the FULL résumé (all roles + bullets + projects), is
 * told to answer each field with ONE focused, in-depth example (not a blend),
 * honours word-count hints in the question, and is shown earlier answers so it
 * picks a different accomplishment instead of repeating itself.
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
  /** Called as each field is answered, so a driver can apply it immediately. */
  onField?: (ref: string, value: string) => void,
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
  // Short gist of each open-ended answer already written, so later fields pick a
  // DIFFERENT example instead of repeating the same story across questions.
  const priorOpenEnded: string[] = [];
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
      const answer = await engine.generate(buildFieldPrompt(profile, role, field, priorOpenEnded.slice(-4)), {
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
      if (cleaned) {
        map[field.ref] = cleaned;
        onField?.(field.ref, cleaned); // stream it out so it lands on the page now
        if (isOpenEnded(field)) priorOpenEnded.push(clip(cleaned.replace(/\s+/g, " "), 180));
      }
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

function buildFieldPrompt(
  profile: string,
  role: string,
  field: FieldForLlm,
  priorOpenEnded: string[],
): ChatMessage[] {
  const guidance = field.options?.length
    ? `This field is a dropdown. Choose EXACTLY ONE of these options and reply with that option's text only:\nOptions: ${field.options.join(" | ")}`
    : isOpenEnded(field)
      ? openEndedGuidance(lengthHint(field.label), priorOpenEnded)
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
        `FORM FIELD:\n"${field.label}"\n\n${guidance}\n\nAnswer:`,
    },
  ];
}

/** Instructions for a prose answer: one deep example, right length, no repeats. */
function openEndedGuidance(len: LengthHint, prior: string[]): string {
  const lengthLine = len.maxWords
    ? `Write ${len.minWords ?? Math.max(50, Math.round(len.maxWords * 0.6))}-${len.maxWords} words — use the space to be thorough and specific.`
    : len.minWords
      ? `Write at least ${len.minWords} words — be thorough and specific.`
      : "Write a substantial answer of about 120-180 words.";
  const avoid = prior.length
    ? "\nYou already used these examples in earlier answers — choose a DIFFERENT accomplishment for this question and do not repeat these points:\n" +
      prior.map((p) => `  - ${p}`).join("\n")
    : "";
  return (
    "Answer in the first person with ONE focused, concrete example from the candidate's REAL experience: " +
    "pick the single most relevant and impressive accomplishment for THIS specific question. " +
    "Do NOT blend several unrelated projects into one answer. Go deep on that one example — the situation, " +
    "what the candidate personally built or decided, the hardest technical part, and the concrete outcome — " +
    "with specific details (systems, technologies, scale, results) drawn from the résumé. " +
    lengthLine +
    avoid
  );
}

function buildProfile(resume: ResumeData): string {
  const parts: string[] = [
    resume.fullName && `Name: ${resume.fullName}`,
    resume.headline && `Title: ${resume.headline}`,
    resume.email && `Email: ${resume.email}`,
    resume.phone && `Phone: ${resume.phone}`,
    resume.location && `Location: ${resume.location}`,
    resume.links.length && `Links: ${resume.links.map((l) => `${l.label} ${l.url}`).join(", ")}`,
    resume.skills.length && `Skills: ${resume.skills.slice(0, 40).join(", ")}`,
    resume.summary && `Summary: ${resume.summary}`,
  ].filter(Boolean) as string[];

  const exp = resume.experiences.slice(0, 6).map((e) => {
    const head = [e.title, e.company].filter(Boolean).join(" at ");
    const dates = [e.startDate, e.endDate].filter(Boolean).join("–");
    const tech = e.skills.length ? `\n  tech: ${e.skills.slice(0, 15).join(", ")}` : "";
    const bullets = e.bullets.slice(0, 8).map((b) => `  • ${b}`).join("\n");
    return `• ${head}${dates ? ` (${dates})` : ""}${tech}${bullets ? `\n${bullets}` : ""}`;
  });
  if (exp.length) parts.push(`EXPERIENCE:\n${exp.join("\n")}`);

  // Projects / Achievements / Certifications — often the strongest, most
  // specific material, and previously omitted from the field-fill prompt.
  const extras = (resume.extraSections ?? [])
    .filter((s) => s.heading && s.items.length)
    .slice(0, 4)
    .map((s) => `${s.heading.toUpperCase()}:\n${s.items.slice(0, 8).map((i) => `  • ${i}`).join("\n")}`);
  if (extras.length) parts.push(extras.join("\n"));

  return clip(parts.join("\n"), 6000);
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

export interface LengthHint {
  minWords?: number;
  maxWords?: number;
}

/** Read an explicit word-count requirement out of a field's label, if any. */
export function lengthHint(label: string): LengthHint {
  const l = label.toLowerCase();
  const range = l.match(/(\d{2,4})\s*(?:-|–|—|to|and)\s*(\d{2,4})\s*words/);
  if (range) return { minWords: Number(range[1]), maxWords: Number(range[2]) };
  const max =
    l.match(/(?:up to|no more than|within|max(?:imum)?(?: of)?|under|fewer than|less than)\s*(\d{2,4})\s*words/) ||
    l.match(/(\d{2,4})\s*words?\s*(?:or fewer|or less|max(?:imum)?)/);
  if (max) return { maxWords: Number(max[1]) };
  const min =
    l.match(/(?:at least|minimum(?: of)?|min)\s*(\d{2,4})\s*words/) ||
    l.match(/(\d{2,4})\s*\+\s*words/) ||
    l.match(/(\d{2,4})\s*words?\s*minimum/);
  if (min) return { minWords: Number(min[1]) };
  return {};
}

function maxTokensFor(field: FieldForLlm): number {
  if (field.options?.length) return 24;
  if (!isOpenEnded(field)) return 48;
  // ~1.9 tokens/word + buffer, so a "150-300 words" ask isn't cut short.
  const targetWords = lengthHint(field.label).maxWords ?? 180;
  return Math.min(900, Math.max(360, Math.round(targetWords * 1.9) + 80));
}

/** Trim to a max length on a word boundary (no mid-word cut). */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
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

  const cap = isOpenEnded(field) ? 3000 : 160;
  return t.slice(0, cap).trim();
}

function trimLabel(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean.length > 44 ? `${clean.slice(0, 44)}…` : clean;
}
