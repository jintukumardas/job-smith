/**
 * Best-effort extraction of structured data from a pasted plain-text resume.
 *
 * Contact details and skills parse reliably; name/headline/location are
 * heuristic. Experience/education are intentionally NOT parsed (too unreliable
 * from free text) — the user adds those as structured entries if they want them.
 *
 * Pure & unit-testable.
 */
import type { ResumeData, ResumeLink } from "../types/index.js";
import { detectSkills } from "./skills.js";

export interface ParsedResume {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: ResumeLink[];
  skills: string[];
}

const ROLE_NOUN =
  /\b(engineer|developer|programmer|architect|scientist|analyst|manager|designer|consultant|lead|sre|devops)\b/i;

const SECTION_HEADER =
  /^(professional\s+summary|summary|experience|education|skills|projects|work\s+history|objective|contact)\b/i;

export function parseResumeText(text: string): ParsedResume {
  const raw = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n").map((l) => l.trim());
  const header = lines.filter(Boolean).slice(0, 10); // contact info lives up top

  const result: ParsedResume = {
    fullName: "",
    headline: "",
    email: extractEmail(raw),
    phone: extractPhone(header),
    location: extractLocation(header),
    links: extractLinks(raw),
    skills: detectSkills(raw),
  };

  const name = extractName(lines);
  if (name) result.fullName = name;
  const headline = extractHeadline(lines, name);
  if (headline) result.headline = headline;

  return result;
}

/**
 * Return a resume with empty top-level fields filled from the pasted base text.
 * Existing values and experience/education entries are preserved.
 */
export function enrichResume(resume: ResumeData): ResumeData {
  if (!resume.baseResumeText.trim()) return resume;
  const p = parseResumeText(resume.baseResumeText);
  return {
    ...resume,
    fullName: resume.fullName || p.fullName,
    headline: resume.headline || p.headline,
    email: resume.email || p.email,
    phone: resume.phone || p.phone,
    location: resume.location || p.location,
    links: resume.links.length ? resume.links : p.links,
    skills: resume.skills.length ? resume.skills : p.skills,
  };
}

/* -------------------------------- helpers -------------------------------- */

function extractEmail(text: string): string {
  const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  return m ? m[0] : "";
}

function extractPhone(header: string[]): string {
  for (const line of header) {
    // A run that looks like a phone number: optional +, then digits/separators,
    // with at least 8 digits total and no percent sign (avoids "10-80%").
    const m = /\+?\d[\d\s().-]{6,}\d/.exec(line);
    if (m && !/%/.test(m[0])) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) return m[0].trim();
    }
  }
  return "";
}

function extractLocation(header: string[]): string {
  // "City, Country" / "City, ST" — possibly inside a "| ... |" contact line.
  const re = /([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+)*),\s*([A-Z][A-Za-z.]{1,})/;
  for (const line of header) {
    for (const segment of line.split("|").map((s) => s.trim())) {
      const m = re.exec(segment);
      if (m) return `${m[1]}, ${m[2]}`;
    }
  }
  return "";
}

function extractLinks(text: string): ResumeLink[] {
  const urls = text.match(/\bhttps?:\/\/[^\s|)<>]+/gi) ?? [];
  const seen = new Set<string>();
  const links: ResumeLink[] = [];
  for (const url of urls) {
    const clean = url.replace(/[.,;]+$/, "");
    if (seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    links.push({ label: labelForUrl(clean), url: clean });
  }
  return links;
}

function labelForUrl(url: string): string {
  const u = url.toLowerCase();
  if (u.includes("linkedin")) return "LinkedIn";
  if (u.includes("github")) return "GitHub";
  if (u.includes("gitlab")) return "GitLab";
  if (u.includes("twitter") || u.includes("x.com")) return "Twitter";
  return "Website";
}

function extractName(lines: string[]): string {
  for (const line of lines.slice(0, 4)) {
    if (!line || line.includes("@") || line.includes("|") || /\d/.test(line)) continue;
    if (SECTION_HEADER.test(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 1 || tokens.length > 5) continue;
    if (tokens.every((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t))) {
      // Avoid all-caps section-like lines (e.g. "CURRICULUM VITAE").
      if (line === line.toUpperCase() && line.length > 16) continue;
      return line;
    }
  }
  return "";
}

function extractHeadline(lines: string[], name: string): string {
  for (const line of lines.filter(Boolean).slice(0, 8)) {
    if (line === name) continue;
    if (line.includes("@") || line.includes("|")) continue;
    if (SECTION_HEADER.test(line)) continue;
    if (line.length <= 60 && ROLE_NOUN.test(line)) return line;
  }
  // Otherwise pull a leading role phrase out of the text (e.g. "Senior Software Engineer").
  const joined = lines.join(" ");
  const m =
    /\b(?:(?:senior|junior|lead|staff|principal|sr\.?|jr\.?)\s+)?(?:[A-Za-z]+\s+){0,2}(?:engineer|developer|programmer|designer|manager|scientist|architect|analyst)\b/i.exec(
      joined,
    );
  if (m) {
    const phrase = m[0].replace(/\s+/g, " ").trim();
    if (phrase.length >= 5 && phrase.length <= 50) return phrase;
  }
  return "";
}
