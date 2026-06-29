/**
 * Pure résumé ↔ job-description matching: gather the skills a résumé evidences,
 * compare them against a JD's skills, and turn that into a 0–100 match score.
 *
 * This module is deliberately light (no engine, no WebLLM, no DOM) so the popup
 * can score every cached listing against the résumé at render time without
 * pulling the model bundle in. `tailor.ts` re-exports these for back-compat.
 */
import type { JdAnalysis, ResumeData } from "../types/index.js";
import { extractJd } from "./jd-parser.js";
import { detectSkills, normalizeSkill, sameSkill } from "./skills.js";
import { tokenize, uniqCi } from "../lib/util.js";

export interface SkillMatch {
  matched: string[];
  missing: string[];
  resumeSkills: string[];
}

/** All canonical skills the resume evidences (declared + per-role + free text). */
export function gatherResumeSkills(resume: ResumeData): string[] {
  const declared = resume.skills.map(normalizeSkill);
  const perRole = resume.experiences.flatMap((e) => e.skills.map(normalizeSkill));
  const fromText = detectSkills(
    [resume.baseResumeText, resume.summary, ...resume.experiences.flatMap((e) => e.bullets)].join(
      "\n",
    ),
  );
  return uniqCi([...declared, ...perRole, ...fromText]);
}

export function computeSkillMatch(resume: ResumeData, jdSkills: string[]): SkillMatch {
  const resumeSkills = gatherResumeSkills(resume);
  const matched = jdSkills.filter((s) => resumeSkills.some((rs) => sameSkill(rs, s)));
  const missing = jdSkills.filter((s) => !matched.some((m) => sameSkill(m, s)));
  return { matched: uniqCi(matched), missing: uniqCi(missing), resumeSkills };
}

export function computeMatchScore(
  matched: string[],
  analysis: JdAnalysis,
  resume: ResumeData,
  resumeSkills: string[],
): number {
  let coverage: number;
  if (analysis.skills.length > 0) {
    coverage = matched.length / analysis.skills.length;
  } else {
    // Fall back to keyword coverage against the resume corpus.
    const corpus = new Set(
      tokenize(
        [resume.summary, resume.headline, ...resumeSkills, ...resume.experiences.flatMap((e) => e.bullets)].join(
          " ",
        ),
      ),
    );
    const kw = analysis.keywords.slice(0, 20);
    coverage = kw.length ? kw.filter((k) => corpus.has(k.toLowerCase())).length / kw.length : 0;
  }

  const role = analysis.role?.toLowerCase() ?? "";
  const roleHaystack = `${resume.headline} ${resume.experiences.map((e) => e.title).join(" ")}`.toLowerCase();
  const roleMatch = role
    ? tokenize(role).some((t) => t.length > 3 && roleHaystack.includes(t))
    : false;

  const score = coverage * 70 + (roleMatch ? 20 : 0) + Math.min(10, matched.length * 2);
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface JobMatch {
  /** 0–100 heuristic résumé↔JD match. */
  score: number;
  /** JD skills the résumé already evidences. */
  matched: string[];
  /** JD skills missing from the résumé (gaps). */
  missing: string[];
}

/** Cap the JD text scored per listing so a giant posting can't stall the popup. */
const MAX_JD_CHARS = 12_000;

/**
 * Score how well a résumé fits a raw job description. Pure and fast — safe to run
 * for every listing in the popup. Returns the score plus the matched/missing
 * skills so the UI can explain the number.
 */
export function matchResumeToJd(resume: ResumeData, jdText: string): JobMatch {
  const analysis = extractJd(jdText.slice(0, MAX_JD_CHARS));
  const { matched, missing, resumeSkills } = computeSkillMatch(resume, analysis.skills);
  const score = computeMatchScore(matched, analysis, resume, resumeSkills);
  return { score, matched, missing };
}

/** True when the résumé has enough content to produce a meaningful match score. */
export function isResumeMatchable(resume: ResumeData): boolean {
  return (
    gatherResumeSkills(resume).length > 0 ||
    resume.baseResumeText.trim().length > 0 ||
    resume.summary.trim().length > 0 ||
    resume.experiences.length > 0
  );
}
