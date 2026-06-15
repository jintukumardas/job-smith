/**
 * Best-effort extraction of structured data from a pasted plain-text resume:
 * contact details, a summary, skills, and — section permitting — experience and
 * education entries (using the user's own verbatim text, never invented).
 *
 * Resume formats vary wildly, so this is heuristic by nature; the user can edit
 * anything after importing. Pure & unit-testable.
 */
import type {
  ResumeData,
  ResumeEducation,
  ResumeExperience,
  ResumeLink,
  ResumeSection,
} from "../types/index.js";
import { detectSkills } from "./skills.js";
import { uid, uniqCi } from "../lib/util.js";

export interface ParsedResume {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  summary: string;
  links: ResumeLink[];
  skills: string[];
  experiences: ResumeExperience[];
  education: ResumeEducation[];
  extraSections: ResumeSection[];
}

type Section = "summary" | "experience" | "education" | "skills";

interface ExtraBlock {
  heading: string;
  lines: string[];
}
interface Sectionized {
  summary: string[];
  experience: string[];
  education: string[];
  skills: string[];
  extras: ExtraBlock[];
}

type HeaderHit =
  | { kind: "standard"; section: Section }
  | { kind: "extra"; heading: string };

const HEADERS: { re: RegExp; section: Section }[] = [
  { re: /^(professional\s+summary|summary|profile|objective|about\s+me)\b/i, section: "summary" },
  {
    re: /^(work\s+experience|professional\s+experience|experience|employment(\s+history)?|work\s+history|career)\b/i,
    section: "experience",
  },
  { re: /^(education|academics?|academic\s+background)\b/i, section: "education" },
  {
    re: /^(skills|technical\s+skills|technologies|tech\s+stack|core\s+competencies|competencies)\b/i,
    section: "skills",
  },
];

/** Recognized non-standard sections, captured with their heading. */
const EXTRA_HEADERS: { re: RegExp; label: string }[] = [
  { re: /^(key\s+)?achievements?\b/i, label: "Achievements" },
  { re: /^(highlights|accomplishments)\b/i, label: "Highlights" },
  { re: /^(notable\s+|key\s+)?projects?\b/i, label: "Projects" },
  { re: /^certifications?\b/i, label: "Certifications" },
  { re: /^(awards?|honou?rs?)\b/i, label: "Awards" },
  { re: /^publications?\b/i, label: "Publications" },
  { re: /^(open[\s-]?source)\b/i, label: "Open Source" },
  { re: /^patents?\b/i, label: "Patents" },
  { re: /^(leadership|volunteer(ing)?|activities|community)\b/i, label: "Leadership & Activities" },
  { re: /^languages?\b/i, label: "Languages" },
  { re: /^interests?\b/i, label: "Interests" },
];

const ROLE_NOUN =
  /\b(engineer|developer|programmer|architect|scientist|analyst|manager|designer|consultant|lead|sre|devops)\b/i;

const BULLET = /^\s*([-*•▪◦·‣]|o\s)\s*/;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE_TOKEN = `(?:${MONTH}\\s*)?\\d{4}|\\d{1,2}\\/\\d{2,4}`;
const DATE_RANGE = new RegExp(
  `((?:${MONTH}\\s*)?\\d{4}|\\d{1,2}\\/\\d{2,4})\\s*[–\\-—]+\\s*(present|current|now|${DATE_TOKEN})`,
  "i",
);

const DEGREE = /\b(b\.?tech|b\.?e\b|b\.?sc|b\.?s\b|bachelor|m\.?tech|m\.?sc|m\.?s\b|master|mba|ph\.?d|diploma|b\.?a\b|m\.?a\b)/i;

export function parseResumeText(text: string): ParsedResume {
  const raw = (text ?? "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n").map((l) => l.trim());
  const header = lines.filter(Boolean).slice(0, 10);

  const sections = sectionize(lines);

  const result: ParsedResume = {
    fullName: extractName(lines),
    headline: "",
    email: extractEmail(raw),
    phone: extractPhone(header),
    location: extractLocation(header),
    summary: cleanSummary(sections.summary),
    links: extractLinks(raw),
    skills: uniqCi([...detectSkills(raw), ...extractRawSkills(sections.skills)]).slice(0, 60),
    experiences: parseExperience(sections.experience),
    education: parseEducation(sections.education),
    extraSections: sections.extras
      .map((e) => ({ heading: e.heading, items: linesToItems(e.lines) }))
      .filter((s) => s.items.length > 0)
      .slice(0, 8),
  };

  result.headline = extractHeadline(lines, result.fullName);
  return result;
}

/** Fill empty resume fields (and empty experience/education) from base text. */
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
    summary: resume.summary || p.summary,
    links: resume.links.length ? resume.links : p.links,
    skills: resume.skills.length ? resume.skills : p.skills,
    experiences: resume.experiences.length ? resume.experiences : p.experiences,
    education: resume.education.length ? resume.education : p.education,
    extraSections: resume.extraSections?.length ? resume.extraSections : p.extraSections,
  };
}

/* ------------------------------ sectionizing ----------------------------- */

function classifyHeader(line: string): HeaderHit | null {
  const l = line.replace(/[:\s]+$/, "");
  if (!l || l.length > 40) return null;
  for (const { re, section } of HEADERS) if (re.test(l)) return { kind: "standard", section };
  for (const { re } of EXTRA_HEADERS) if (re.test(l)) return { kind: "extra", heading: prettyHeading(l) };
  return null;
}

function prettyHeading(line: string): string {
  return /[a-z]/.test(line) ? line.trim() : line.trim().toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function sectionize(lines: string[]): Sectionized {
  const out: Sectionized = { summary: [], experience: [], education: [], skills: [], extras: [] };
  let current: HeaderHit | null = null;
  let curExtra: ExtraBlock | null = null;
  for (const line of lines) {
    const header = classifyHeader(line);
    if (header) {
      current = header;
      if (header.kind === "extra") {
        curExtra = { heading: header.heading, lines: [] };
        out.extras.push(curExtra);
      } else {
        curExtra = null;
      }
      continue;
    }
    if (!current) continue;
    if (current.kind === "standard") out[current.section].push(line);
    else if (curExtra) curExtra.lines.push(line);
  }
  return out;
}

function linesToItems(lines: string[]): string[] {
  return lines.map((l) => l.replace(BULLET, "").trim()).filter((l) => l.length >= 2).slice(0, 20);
}

function extractRawSkills(lines: string[]): string[] {
  const items: string[] = [];
  for (const raw of lines) {
    if (!raw) continue;
    let line = raw.replace(BULLET, "").trim();
    const colon = line.indexOf(":"); // drop a "Languages:" / "Tools:" category prefix
    if (colon > 0 && colon <= 24 && /^[A-Za-z /&]+$/.test(line.slice(0, colon))) {
      line = line.slice(colon + 1);
    }
    for (const part of line.split(/[,|•·;]|\s{2,}/)) {
      const s = part.trim().replace(/\.$/, "");
      if (s.length >= 2 && s.length <= 40 && !/^[-–]/.test(s)) items.push(s);
    }
  }
  return uniqCi(items).slice(0, 50);
}

/* ------------------------------- experience ------------------------------ */

function parseExperience(lines: string[], max = 12): ResumeExperience[] {
  const ls = lines.map((l) => l.trim());
  // Each job carries a date range; anchor on those so plain-paragraph resumes
  // (no "•" bullet markers) still split into entries with their descriptions.
  const anchors: number[] = [];
  ls.forEach((l, i) => {
    if (l && DATE_RANGE.test(l)) anchors.push(i);
  });
  if (anchors.length === 0) return parseExperienceByBullets(ls, max);

  const entries: ResumeExperience[] = [];
  for (let k = 0; k < anchors.length; k++) {
    const a = anchors[k];
    let headerIdx = a - 1;
    while (headerIdx >= 0 && !ls[headerIdx]) headerIdx--;
    const header = headerIdx >= 0 ? ls[headerIdx] : "";

    let end = ls.length;
    if (k + 1 < anchors.length) {
      let nextHeader = anchors[k + 1] - 1; // the next entry's header line
      while (nextHeader > a && !ls[nextHeader]) nextHeader--;
      end = nextHeader;
    }
    const bullets: string[] = [];
    for (let i = a + 1; i < end; i++) {
      const b = ls[i];
      if (b) bullets.push(b.replace(BULLET, "").trim());
    }
    entries.push(toExperienceFromParts(header, ls[a], bullets));
  }
  return entries.filter((e) => e.title || e.company || e.bullets.length > 0).slice(0, max);
}

function toExperienceFromParts(header: string, dateLine: string, bullets: string[]): ResumeExperience {
  const exp: ResumeExperience = { id: uid("exp"), company: "", title: "", bullets, skills: [] };
  const dm = DATE_RANGE.exec(dateLine);
  if (dm) {
    exp.startDate = normalizeDate(dm[1]);
    exp.endDate = normalizeDate(dm[2]);
    const loc = dateLine.replace(dm[0], " ").replace(/^[\s·|,–—-]+|[\s·|,–—-]+$/g, "").trim();
    if (loc) exp.location = loc;
  }
  assignTitleCompany(exp, header);
  exp.skills = detectSkills([exp.title, exp.company, ...bullets].join(" "));
  return exp;
}

/** Split a "Company — Title" / "Title — Company" header into the two fields. */
function assignTitleCompany(exp: ResumeExperience, header: string): void {
  const segs = header
    .split(/\s*[|·—–]\s*|\s+-\s+/)
    .map((s) => s.replace(/^[,\s]+|[,\s]+$/g, "").trim())
    .filter(Boolean);

  const atMatch = /^(.*?)\s+\bat\b\s+(.*)$/i.exec(segs[0] ?? "");
  if (atMatch) {
    exp.title = atMatch[1].trim();
    exp.company = atMatch[2].trim();
    return;
  }
  if (segs.length >= 2) {
    const titleSeg = segs.find((s) => ROLE_NOUN.test(s));
    if (titleSeg) {
      exp.title = titleSeg;
      exp.company = segs.find((s) => s !== titleSeg) ?? "";
    } else {
      exp.company = segs[0];
      exp.title = segs[1];
    }
    return;
  }
  const comma = /^(.*?),\s*(.*)$/.exec(segs[0] ?? "");
  if (comma) {
    exp.title = comma[1].trim();
    exp.company = comma[2].trim();
  } else if (ROLE_NOUN.test(segs[0] ?? "")) {
    exp.title = segs[0] ?? "";
  } else {
    exp.company = segs[0] ?? "";
  }
}

/** Fallback for resumes that use "•" markers but have no parseable dates. */
function parseExperienceByBullets(lines: string[], max: number): ResumeExperience[] {
  interface Raw {
    headerLines: string[];
    bullets: string[];
  }
  const entries: Raw[] = [];
  let cur: Raw | null = null;
  let lastWasBullet = false;
  for (const line of lines) {
    if (!line) continue;
    if (BULLET.test(line)) {
      if (!cur) {
        cur = { headerLines: [], bullets: [] };
        entries.push(cur);
      }
      cur.bullets.push(line.replace(BULLET, "").trim());
      lastWasBullet = true;
    } else if (!cur || lastWasBullet) {
      cur = { headerLines: [line], bullets: [] };
      entries.push(cur);
      lastWasBullet = false;
    } else {
      cur.headerLines.push(line);
      lastWasBullet = false;
    }
  }
  return entries
    .map((e) => {
      const exp: ResumeExperience = { id: uid("exp"), company: "", title: "", bullets: e.bullets, skills: [] };
      let header = e.headerLines.join(" | ");
      const dm = DATE_RANGE.exec(header);
      if (dm) {
        exp.startDate = normalizeDate(dm[1]);
        exp.endDate = normalizeDate(dm[2]);
        header = header.replace(dm[0], " ").trim();
      }
      assignTitleCompany(exp, header);
      exp.skills = detectSkills([exp.title, exp.company, ...e.bullets].join(" "));
      return exp;
    })
    .filter((e) => e.title || e.company || e.bullets.length > 0)
    .slice(0, max);
}

function normalizeDate(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\b(present|current|now)\b/i, "Present").trim();
}

/* ------------------------------- education ------------------------------- */

function parseEducation(lines: string[], max = 6): ResumeEducation[] {
  const out: ResumeEducation[] = [];
  const seen = new Set<string>();
  const monthRe = new RegExp(`\\b${MONTH}\\b`, "gi");
  for (const line of lines) {
    if (!line || BULLET.test(line)) continue;
    // Skip grade/score detail lines (they belong to the entry above, not new ones).
    if (/^\s*(grade|cgpa|gpa|percentage|score|marks)\b/i.test(line)) continue;

    const range = new RegExp(
      `((19|20)\\d{2})\\s*[-–—]+\\s*(?:${MONTH}\\s*)?((19|20)\\d{2}|present|current|now)`,
      "i",
    ).exec(line);
    const single = /(19|20)\d{2}/.exec(line);
    const year = range ? `${range[1]}-${range[3]}` : single ? single[0] : undefined;

    const cleaned = line
      .replace(/\(?\s*(19|20)\d{2}\s*(?:[-–—]\s*((19|20)\d{2}|present))?\s*\)?/gi, " ")
      .replace(monthRe, " ")
      .replace(/\b(grade|cgpa|gpa)\b.*$/i, " ")
      .replace(/[•·]/g, " ")
      .replace(/\s*[-–—]\s*[-–—]\s*/g, " - ")
      .replace(/\s{2,}/g, " ")
      .replace(/^[\s,–—-]+|[\s,–—-]+$/g, "")
      .trim();
    if (!cleaned) continue;

    const parts = cleaned.split(/\s+[-–—]\s+|,\s*|\s+\bat\b\s+/i).map((s) => s.trim()).filter(Boolean);
    const degreePart = parts.find((p) => DEGREE.test(p));
    const institution = (parts.find((p) => p !== degreePart) ?? parts[0] ?? cleaned)
      .replace(/[-–—\s]+$/, "")
      .trim();

    const edu: ResumeEducation = { institution };
    if (degreePart) edu.degree = degreePart;
    if (year) edu.year = year;
    const key = `${edu.degree ?? ""}|${edu.institution}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (edu.institution || edu.degree) out.push(edu);
    if (out.length >= max) break;
  }
  return out;
}

/* -------------------------------- helpers -------------------------------- */

function cleanSummary(lines: string[]): string {
  const text = lines.filter((l) => !BULLET.test(l)).join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= 1000) return text;
  // Truncate at a sentence boundary (never mid-word).
  const slice = text.slice(0, 1000);
  const lastDot = slice.lastIndexOf(". ");
  if (lastDot > 400) return slice.slice(0, lastDot + 1);
  const lastSpace = slice.lastIndexOf(" ");
  return `${slice.slice(0, lastSpace > 0 ? lastSpace : 1000).trim()}…`;
}

function extractEmail(text: string): string {
  const m = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(text);
  return m ? m[0] : "";
}

function extractPhone(header: string[]): string {
  for (const line of header) {
    const m = /\+?\d[\d\s().-]{6,}\d/.exec(line);
    if (m && !/%/.test(m[0])) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 8 && digits.length <= 15) return m[0].trim();
    }
  }
  return "";
}

function extractLocation(header: string[]): string {
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
    if (classifyHeader(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 1 || tokens.length > 5) continue;
    if (tokens.every((t) => /^[A-Za-z][A-Za-z.'-]*$/.test(t))) {
      if (line === line.toUpperCase() && line.length > 16) continue;
      return line;
    }
  }
  return "";
}

function extractHeadline(lines: string[], name: string): string {
  for (const line of lines.filter(Boolean).slice(0, 8)) {
    if (line === name || line.includes("@") || line.includes("|")) continue;
    if (classifyHeader(line)) continue;
    if (line.length <= 60 && ROLE_NOUN.test(line)) return line;
  }
  const m =
    /\b(?:(?:senior|junior|lead|staff|principal|sr\.?|jr\.?)\s+)?(?:[A-Za-z]+\s+){0,2}(?:engineer|developer|programmer|designer|manager|scientist|architect|analyst)\b/i.exec(
      lines.join(" "),
    );
  if (m) {
    const phrase = m[0].replace(/\s+/g, " ").trim();
    if (phrase.length >= 5 && phrase.length <= 50) return phrase;
  }
  return "";
}
