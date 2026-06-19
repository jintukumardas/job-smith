/**
 * On-device LLM résumé parser. Where the deterministic {@link parseResumeText}
 * relies on regexes/headers (and struggles with unusual layouts), this asks the
 * WebLLM model to *understand* the pasted résumé and return structured JSON.
 *
 * It is strictly extractive: the prompt forbids inventing any fact. Results are
 * merged with the deterministic parse as a safety net — regex wins for things it
 * never gets wrong (email/phone/URLs), the model wins for the understanding-heavy
 * fields (name, headline, summary, splitting experiences, skills).
 */
import type { ResumeData, ResumeEducation, ResumeExperience, ResumeLink, ResumeSection } from "../types/index.js";
import type { ChatMessage } from "./llm-protocol.js";
import type { ParsedResume } from "./parse-resume.js";
import { getWebLLMEngine } from "./tailor.js";
import { detectSkills } from "./skills.js";
import { uid, uniqCi } from "../lib/util.js";
import { createLogger } from "../lib/logger.js";
import type { Settings } from "../types/index.js";

const log = createLogger("parse-resume-llm");

/**
 * Parse the résumé text with the on-device model. Returns the structured result,
 * or null if the model is unavailable / produced nothing usable (caller should
 * then fall back to the deterministic parser).
 */
export async function parseResumeWithLlm(
  text: string,
  settings: Settings,
  onProgress?: (progress: number, message: string) => void,
  onToken?: (chars: number) => void,
): Promise<ParsedResume | null> {
  const clean = (text ?? "").trim();
  if (!clean) return null;

  const engine = await getWebLLMEngine(settings);
  if (!engine) return null;

  let raw = "";
  let chars = 0;
  try {
    raw = await engine.generate(buildParsePrompt(clean), {
      maxTokens: 2048,
      temperature: 0.1, // extraction wants determinism, not creativity
      json: true,
      ...(onProgress ? { onProgress } : {}),
      onToken: (t) => {
        chars += t.length;
        onToken?.(chars);
      },
    });
  } catch (e) {
    log.warn("LLM résumé parse failed", e);
    return null;
  }
  return parsedFromJson(raw, clean);
}

const PARSE_SCHEMA = `{
  "fullName": "",
  "headline": "the candidate's title taken straight from the résumé (their most recent role); '' if none — never invent or inflate seniority",
  "email": "",
  "phone": "",
  "location": "City, Country",
  "summary": "the professional summary/objective if present, else ''",
  "links": [{"label": "LinkedIn|GitHub|GitLab|Portfolio|Website", "url": ""}],
  "skills": ["every distinct skill/technology the candidate lists or clearly uses"],
  "experiences": [
    {"title": "", "company": "", "startDate": "", "endDate": "", "location": "", "bullets": ["each responsibility/achievement, verbatim or lightly cleaned"]}
  ],
  "education": [{"degree": "", "institution": "", "year": ""}],
  "extraSections": [{"heading": "Projects|Certifications|Achievements|Awards|Publications|Languages", "items": ["each item"]}]
}`;

export function buildParsePrompt(text: string): ChatMessage[] {
  return [
    {
      role: "system",
      content:
        "You are a precise résumé parser. Extract the candidate's information from the RÉSUMÉ TEXT into JSON. " +
        "STRICT RULES: use ONLY text that appears in the résumé — never invent or guess emails, phone numbers, " +
        "dates, employers, titles, or skills, and never inflate seniority (do not upgrade a role to " +
        "'Senior'/'Lead'/'Principal' or change the field, e.g. to 'AI Engineer', unless the résumé says so). " +
        "If a value isn't present, use an empty string or empty array. " +
        "Split work history into SEPARATE experience entries (one per job) with title, company, dates and bullet " +
        "points; keep bullets close to the original wording. Capture ALL skills the candidate lists. " +
        "Reply with ONLY a JSON object in exactly this shape — no markdown, no code fences, no commentary:\n" +
        PARSE_SCHEMA,
    },
    {
      role: "user",
      content: `RÉSUMÉ TEXT:\n${text.slice(0, 8000)}\n\nJSON:`,
    },
  ];
}

/** Parse the model's raw text into a {@link ParsedResume} (pure & testable). */
export function parsedFromJson(raw: string, sourceText = ""): ParsedResume | null {
  const obj = extractJsonObject(raw);
  if (!obj) return null;

  const links = arr(obj.links).map(toLink).filter((l) => l.url);
  const skills = uniqCi(arr(obj.skills).map(str).filter(Boolean)).slice(0, 60);
  const experiences = arr(obj.experiences)
    .map(toExperience)
    .filter((e) => e.title || e.company || e.bullets.length > 0)
    .slice(0, 12);
  const education = arr(obj.education)
    .map(toEducation)
    .filter((e) => e.institution || e.degree)
    .slice(0, 6);
  const extraSections = arr(obj.extraSections)
    .map(toSection)
    .filter((s) => s.heading && s.items.length > 0)
    .slice(0, 8);

  const parsed: ParsedResume = {
    fullName: str(obj.fullName),
    headline: str(obj.headline),
    email: str(obj.email),
    phone: str(obj.phone),
    location: str(obj.location),
    summary: str(obj.summary),
    links,
    skills,
    experiences,
    education,
    extraSections,
  };

  // Nothing meaningful came back — let the caller fall back to deterministic.
  if (!parsed.fullName && !parsed.email && experiences.length === 0 && skills.length === 0) {
    return null;
  }

  // Best-effort: ensure each experience carries detected skills for matching.
  for (const exp of parsed.experiences) {
    if (exp.skills.length === 0) {
      exp.skills = detectSkills([exp.title, exp.company, ...exp.bullets].join(" "));
    }
  }
  void sourceText;
  return parsed;
}

/**
 * Merge the LLM parse over the deterministic parse. Regex wins where it is
 * reliable and the model can transcribe wrongly (email/phone/links); the model
 * wins for the understanding-heavy fields.
 */
export function mergeParsed(ai: ParsedResume, det: ParsedResume): ParsedResume {
  return {
    fullName: ai.fullName || det.fullName,
    headline: ai.headline || det.headline,
    email: det.email || ai.email, // regex never hallucinates an address
    phone: det.phone || ai.phone,
    location: ai.location || det.location,
    summary: ai.summary || det.summary,
    links: det.links.length ? det.links : ai.links, // regex URLs are exact
    skills: ai.skills.length ? uniqCi([...ai.skills, ...det.skills]).slice(0, 60) : det.skills,
    experiences: ai.experiences.length ? ai.experiences : det.experiences,
    education: ai.education.length ? ai.education : det.education,
    extraSections: ai.extraSections.length ? ai.extraSections : det.extraSections,
  };
}

/** Overwrite résumé fields with any non-empty parsed value (import semantics). */
export function applyParsedToResume(resume: ResumeData, p: ParsedResume): number {
  let changed = 0;
  const setStr = (key: "fullName" | "headline" | "email" | "phone" | "location" | "summary", v: string): void => {
    if (v && resume[key] !== v) {
      resume[key] = v;
      changed++;
    }
  };
  setStr("fullName", p.fullName);
  setStr("headline", p.headline);
  setStr("email", p.email);
  setStr("phone", p.phone);
  setStr("location", p.location);
  setStr("summary", p.summary);
  if (p.links.length) {
    resume.links = p.links;
    changed++;
  }
  if (p.skills.length) {
    resume.skills = p.skills;
    changed += p.skills.length;
  }
  if (p.experiences.length) {
    resume.experiences = p.experiences;
    changed += p.experiences.length;
  }
  if (p.education.length) {
    resume.education = p.education;
    changed += p.education.length;
  }
  if (p.extraSections.length) {
    resume.extraSections = p.extraSections;
    changed += p.extraSections.length;
  }
  return changed;
}

/* -------------------------------- helpers -------------------------------- */

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

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function toLink(o: unknown): ResumeLink {
  const r = (o ?? {}) as Record<string, unknown>;
  const url = str(r.url);
  const label = str(r.label) || labelForUrl(url);
  return { label, url };
}

function labelForUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("linkedin")) return "LinkedIn";
  if (u.includes("github")) return "GitHub";
  if (u.includes("gitlab")) return "GitLab";
  if (u.includes("twitter") || u.includes("x.com")) return "Twitter";
  return "Website";
}

function toExperience(o: unknown): ResumeExperience {
  const r = (o ?? {}) as Record<string, unknown>;
  const bullets = arr(r.bullets).map(str).filter(Boolean).slice(0, 16);
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

function toSection(o: unknown): ResumeSection {
  const r = (o ?? {}) as Record<string, unknown>;
  const items = arr(r.items).map(str).filter(Boolean).slice(0, 20);
  return { heading: str(r.heading), items };
}
