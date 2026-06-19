/**
 * Cover-letter generation. On-device WebLLM when available, deterministic
 * template otherwise. Strictly truthful: the model may only use facts from the
 * candidate's résumé and must not inflate seniority or invent claims — it may
 * emphasise real experience/technologies that fit the role.
 */
import type { ResumeData, Settings } from "../types/index.js";
import type { ChatMessage } from "./llm-protocol.js";
import { getWebLLMEngine, computeSkillMatch } from "./tailor.js";
import { extractJd } from "./jd-parser.js";
import { enrichResume } from "./parse-resume.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("cover-letter");

export interface CoverLetterMeta {
  title?: string;
  company?: string;
}

export interface CoverLetterResult {
  text: string;
  engine: "webllm" | "deterministic";
}

export async function generateCoverLetter(
  rawResume: ResumeData,
  jdText: string,
  meta: CoverLetterMeta,
  settings: Settings,
  onProgress?: (progress: number, message: string) => void,
): Promise<CoverLetterResult> {
  const resume = enrichResume(rawResume);
  const analysis = extractJd(jdText);
  const { matched } = computeSkillMatch(resume, analysis.skills);

  const engine = settings.llm.enabled ? await getWebLLMEngine(settings) : null;
  if (engine) {
    try {
      const raw = await engine.generate(buildCoverPrompt(resume, jdText, meta, matched), {
        maxTokens: 700,
        temperature: Math.min(settings.llm.temperature, 0.5),
        ...(onProgress ? { onProgress } : {}),
      });
      const text = cleanLetter(raw, resume, meta);
      if (text && text.length > 120) return { text, engine: "webllm" };
    } catch (e) {
      log.warn("cover letter generation failed; using deterministic template", e);
    }
  }
  return { text: composeDeterministic(resume, meta, matched), engine: "deterministic" };
}

/* -------------------------------- prompt --------------------------------- */

function buildCoverPrompt(
  resume: ResumeData,
  jdText: string,
  meta: CoverLetterMeta,
  matched: string[],
): ChatMessage[] {
  const exp = resume.experiences
    .slice(0, 3)
    .map((e) => {
      const head = [e.title, e.company].filter(Boolean).join(" at ");
      const bullets = e.bullets.slice(0, 3).map((b) => `  - ${b}`).join("\n");
      return bullets ? `${head}\n${bullets}` : head;
    })
    .join("\n");

  const profile = [
    resume.fullName && `Name: ${resume.fullName}`,
    resume.headline && `Current title: ${resume.headline}`,
    resume.location && `Location: ${resume.location}`,
    resume.skills.length && `Skills: ${resume.skills.slice(0, 25).join(", ")}`,
    resume.summary && `Summary: ${resume.summary}`,
    exp && `Experience:\n${exp}`,
  ]
    .filter(Boolean)
    .join("\n");

  const target = [meta.title && `Role: ${meta.title}`, meta.company && `Company: ${meta.company}`]
    .filter(Boolean)
    .join(" | ");

  return [
    {
      role: "system",
      content:
        "You write a concise, professional cover letter (180-260 words) for a job application. " +
        "STRICT TRUTHFULNESS: use ONLY facts from the candidate's résumé. Never invent or inflate — do NOT " +
        "claim skills, employers, titles, metrics, or seniority the résumé does not show (e.g. do not call them " +
        "'Senior'/'Lead' or a different role like 'AI Engineer' unless stated). You MAY emphasise the candidate's " +
        "real experience and technologies that genuinely fit the role. Map their ACTUAL experience to the job's needs. " +
        "Structure: 'Dear Hiring Manager,'; a short opening naming the role and genuine interest; 1-2 body paragraphs " +
        "tying real experience to the role; a brief closing; then 'Sincerely,' and the candidate's name. " +
        "Plain text only. Never output placeholders like [Company] or [Your Name] — use the values given, or phrase " +
        "around what is missing. Output ONLY the letter.",
    },
    {
      role: "user",
      content:
        `CANDIDATE RÉSUMÉ:\n${profile}\n\n` +
        (target ? `TARGET ${target}\n` : "") +
        (matched.length ? `Relevant overlapping skills: ${matched.slice(0, 12).join(", ")}\n` : "") +
        `\nJOB POSTING:\n${jdText.slice(0, 2500)}\n\nCover letter:`,
    },
  ];
}

/** Strip code fences / leftover placeholders and ensure the name signs off. */
function cleanLetter(raw: string, resume: ResumeData, meta: CoverLetterMeta): string {
  let text = raw.replace(/```[a-z]*\n?/gi, "").trim();
  // Replace any unfilled bracket placeholders with real values (or remove).
  text = text
    .replace(/\[(your name|name|full name)\]/gi, resume.fullName || "")
    .replace(/\[(company|company name)\]/gi, meta.company || "the team")
    .replace(/\[(position|role|title|job title)\]/gi, meta.title || "this role")
    .replace(/\[[^\]]*\]/g, "") // drop any remaining [placeholder]
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Ensure the candidate's name appears at the end if we have one.
  if (resume.fullName && !text.toLowerCase().includes(resume.fullName.toLowerCase())) {
    text = `${text}\n\n${resume.fullName}`;
  }
  return text;
}

/* --------------------------- deterministic fallback ---------------------- */

function composeDeterministic(resume: ResumeData, meta: CoverLetterMeta, matched: string[]): string {
  const role = meta.title || "the open role";
  const company = meta.company ? ` at ${meta.company}` : "";
  const top = resume.experiences[0];
  const topLine = top
    ? `In my ${[top.title, top.company].filter(Boolean).join(" role at ") || "current role"}, ${
        top.bullets[0] ? lowerFirst(top.bullets[0].replace(/\.$/, "")) : "I delivered work directly relevant to this position"
      }.`
    : "";
  const skillsLine = matched.length
    ? `My experience with ${matched.slice(0, 6).join(", ")} maps closely to what this role needs.`
    : resume.skills.length
      ? `I bring hands-on experience with ${resume.skills.slice(0, 6).join(", ")}.`
      : "";
  const summaryLine = resume.summary ? ` ${resume.summary.trim()}` : "";

  return [
    "Dear Hiring Manager,",
    "",
    `I'm writing to apply for ${role}${company}.${summaryLine}`.trim(),
    "",
    [topLine, skillsLine].filter(Boolean).join(" "),
    "",
    "I'd welcome the chance to discuss how my background fits your team. Thank you for your time and consideration.",
    "",
    "Sincerely,",
    resume.fullName || "",
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
