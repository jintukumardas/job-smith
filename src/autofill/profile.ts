/**
 * Derive autofill values from the user's resume so they don't have to type their
 * details twice. Any explicit value the user set on an autofill field overrides
 * the derived one. Pure & unit-testable.
 */
import type { AutofillField, ResumeData, Settings } from "../types/index.js";
import { enrichResume } from "../resume/parse-resume.js";

/** Map resume data onto canonical autofill keys. */
export function deriveAutofillValues(rawResume: ResumeData, now = Date.now()): Record<string, string> {
  const resume = enrichResume(rawResume); // also mine the pasted base resume text
  const out: Record<string, string> = {};
  const set = (key: string, value: string | undefined): void => {
    if (value && value.trim() && !out[key]) out[key] = value.trim();
  };

  const { first, last } = splitName(resume.fullName);
  set("firstName", first);
  set("lastName", last);
  set("fullName", resume.fullName);
  set("email", resume.email);
  set("phone", resume.phone);

  set("location", resume.location);
  const loc = parseLocation(resume.location);
  set("city", loc.city);
  set("state", loc.state);
  set("country", loc.country);

  for (const link of resume.links) {
    const url = (link.url || "").trim();
    if (!url) continue;
    const hay = `${link.label} ${url}`.toLowerCase();
    if (/linkedin/.test(hay)) set("linkedin", url);
    else if (/github/.test(hay)) set("github", url);
    else set("portfolio", url);
  }

  const exp = resume.experiences[0];
  if (exp) {
    set("currentCompany", exp.company);
    set("currentTitle", exp.title);
  }

  const yoe = estimateYears(resume, now);
  if (yoe > 0) set("yearsExperience", String(yoe));

  return out;
}

/**
 * Return autofill fields with values filled from the resume where the user
 * hasn't set an explicit value. Explicit values win.
 */
export function resolveAutofillFields(settings: Settings): AutofillField[] {
  const derived = deriveAutofillValues(settings.resume);
  return settings.autofill.fields.map((f) => {
    if (f.value && f.value.trim()) return f;
    const v = derived[f.key];
    return v ? { ...f, value: v } : f;
  });
}

/* -------------------------------- helpers -------------------------------- */

export function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: "", last: "" };
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts[0], last: parts.slice(1).join(" ") };
}

export interface ParsedLocation {
  city: string;
  state: string;
  country: string;
}

/** Best-effort parse of "City, State, Country" / "City, Country" strings. */
export function parseLocation(raw: string): ParsedLocation {
  const cleaned = raw.replace(/\([^)]*\)/g, " "); // drop "(Remote)" etc.
  const parts = cleaned
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { city: "", state: "", country: "" };
  if (parts.length === 1) return { city: parts[0], state: "", country: "" };
  if (parts.length === 2) return { city: parts[0], state: "", country: parts[1] };
  return { city: parts[0], state: parts[1], country: parts[parts.length - 1] };
}

function estimateYears(resume: ResumeData, now: number): number {
  const currentYear = new Date(now).getFullYear();
  let earliest = Infinity;
  for (const exp of resume.experiences) {
    const year = firstYear(exp.startDate);
    if (year && year < earliest) earliest = year;
  }
  if (!Number.isFinite(earliest)) return 0;
  return Math.max(0, Math.min(60, currentYear - earliest));
}

function firstYear(value: string | undefined): number | null {
  if (!value) return null;
  const m = /(19|20)\d{2}/.exec(value);
  return m ? Number(m[0]) : null;
}
