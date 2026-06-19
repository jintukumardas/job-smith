/**
 * Top-level resume tailoring: parse the JD, compute skill match, run the chosen
 * engine (WebLLM with deterministic fallback), and assemble the final tailored
 * resume + diagnostics.
 *
 * A warm WebLLM engine is cached per-model so repeated tailoring in one page
 * session does not reload the model.
 */
import type { ResumeData, Settings, TailoredResume } from "../types/index.js";
import type { EngineProgress, EngineTailorResult, ResumeEngine, TailorRequest } from "./engine.js";
import { extractJd } from "./jd-parser.js";
import { enrichResume } from "./parse-resume.js";
import { detectSkills, normalizeSkill, sameSkill } from "./skills.js";
import { DeterministicEngine, composeSummary } from "./deterministic.js";
import { WebLLMEngine } from "./webllm.js";
import { renderResumeMarkdown, renderResumeHtml, type RenderedExperience } from "./render.js";
import { tokenize, uniqCi } from "../lib/util.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tailor");

export interface TailorOptions {
  onProgress?: (p: EngineProgress) => void;
  signal?: AbortSignal;
  /** Force a specific engine (used by the UI toggle / tests). */
  forceEngine?: "webllm" | "deterministic";
}

/* ------------------------------ engine cache ----------------------------- */

let cachedWebLLM: { model: string; engine: WebLLMEngine } | null = null;
const deterministic = new DeterministicEngine();

/** Dispose any warm WebLLM worker (call when the model setting changes). */
export function resetEngineCache(): void {
  cachedWebLLM?.engine.dispose();
  cachedWebLLM = null;
}

/**
 * Return the warm, cached WebLLM engine if on-device AI is enabled AND usable
 * (WebGPU present), else null. Shared so résumé parsing, tailoring and cover
 * letters all reuse a single model load in one page session.
 */
export async function getWebLLMEngine(settings: Settings): Promise<WebLLMEngine | null> {
  if (!settings.llm.enabled || settings.llm.engine !== "webllm") return null;
  if (!cachedWebLLM || cachedWebLLM.model !== settings.llm.model) {
    cachedWebLLM?.engine.dispose();
    cachedWebLLM = { model: settings.llm.model, engine: new WebLLMEngine(settings.llm.model) };
  }
  return (await cachedWebLLM.engine.isAvailable()) ? cachedWebLLM.engine : null;
}

async function resolveEngine(
  settings: Settings,
  force: TailorOptions["forceEngine"],
): Promise<{ engine: ResumeEngine; fellBack: boolean }> {
  const wantLlm = force === "webllm" || (!force && settings.llm.enabled && settings.llm.engine === "webllm");
  if (!wantLlm) return { engine: deterministic, fellBack: false };

  if (!cachedWebLLM || cachedWebLLM.model !== settings.llm.model) {
    cachedWebLLM?.engine.dispose();
    cachedWebLLM = { model: settings.llm.model, engine: new WebLLMEngine(settings.llm.model) };
  }
  const available = await cachedWebLLM.engine.isAvailable();
  if (!available) {
    log.warn("WebLLM unavailable (no WebGPU?), falling back to deterministic engine");
    return { engine: deterministic, fellBack: true };
  }
  return { engine: cachedWebLLM.engine, fellBack: false };
}

/* --------------------------------- public -------------------------------- */

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

export async function tailorResume(
  resume: ResumeData,
  jdText: string,
  settings: Settings,
  options: TailorOptions = {},
): Promise<TailoredResume> {
  resume = enrichResume(resume); // fill empty fields/experience from pasted base text
  const analysis = extractJd(jdText);
  const { matched, missing, resumeSkills } = computeSkillMatch(resume, analysis.skills);

  const req: TailorRequest = {
    resume,
    jd: jdText,
    analysis,
    resumeSkills,
    matchedSkills: matched,
    missingSkills: missing,
    temperature: settings.llm.temperature,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const { engine, fellBack } = await resolveEngine(settings, options.forceEngine);
  const extraNotes: string[] = [];
  let engineKind: "webllm" | "deterministic" = fellBack ? "deterministic" : engine.kind;

  let result: EngineTailorResult;
  try {
    result = await engine.tailor(req);
  } catch (e) {
    if (engine.kind === "webllm") {
      log.warn("WebLLM tailoring failed; using the deterministic engine", e);
      result = await deterministic.tailor(req);
      extraNotes.push("On-device model failed to run; used the offline engine instead.");
      engineKind = "deterministic";
    } else {
      throw e;
    }
  }
  if (fellBack) extraNotes.unshift("WebLLM was unavailable; used the offline engine instead.");

  return assemble(req, result, extraNotes, engineKind);
}

/* ------------------------------- assembly -------------------------------- */

function assemble(
  req: TailorRequest,
  result: EngineTailorResult,
  extraNotes: string[],
  engineKind: "webllm" | "deterministic",
): TailoredResume {
  const { resume, analysis, matchedSkills: matched, missingSkills: missing, resumeSkills } = req;
  const content = result.content;
  const notes = [...result.notes];

  // Keep the candidate's FULL skillset (anything truthfully in their resume),
  // most-relevant first, dropping only invented skills and JD gaps.
  const sourceLower = [
    resume.baseResumeText,
    resume.skills.join(" "),
    resume.summary,
    resume.headline,
    ...resume.experiences.flatMap((e) => [e.title, e.company ?? "", ...e.bullets]),
    ...(resume.extraSections ?? []).flatMap((s) => s.items),
  ]
    .join(" ")
    .toLowerCase();

  const isGap = (s: string): boolean => missing.some((m) => sameSkill(m, s));
  const isTruthful = (s: string): boolean =>
    resume.skills.some((rs) => sameSkill(rs, s)) ||
    resumeSkills.some((rs) => sameSkill(rs, s)) ||
    sourceLower.includes(s.toLowerCase());

  const llmSkills = content.skills.filter((s) => isTruthful(s) && !isGap(s));
  const ownSkills = resume.skills.filter((s) => !isGap(s));
  const orderedSkills = uniqCi([...matched, ...llmSkills, ...ownSkills]).slice(0, 40);

  // Anti-fabrication: if the summary claims a skill the candidate lacks, replace
  // it with a truthful, deterministic summary.
  let summary = content.summary.trim() || resume.summary.trim();
  const summarySkills = detectSkills(summary);
  if (missing.some((m) => summarySkills.some((s) => sameSkill(s, m)))) {
    summary = composeSummary(req);
    notes.push("Adjusted the summary to avoid claiming skills not in your resume.");
  }

  const experiences: RenderedExperience[] = content.experiences.map((exp) => ({
    exp,
    bullets: exp.bullets,
  }));

  const renderResume: ResumeData = {
    ...content,
    skills: orderedSkills,
    baseResumeText: "",
  };
  const renderInput = {
    resume: renderResume,
    summary,
    orderedSkills,
    experiences,
    extraSections: content.extraSections,
  };
  const markdown = renderResumeMarkdown(renderInput);
  const html = renderResumeHtml(renderInput);
  const matchScore = computeMatchScore(matched, analysis, resume, resumeSkills);

  return {
    markdown,
    html,
    engine: engineKind,
    matchedSkills: matched,
    missingSkills: missing,
    matchScore,
    summary,
    notes: [...notes, ...extraNotes],
  };
}

export function computeMatchScore(
  matched: string[],
  analysis: ReturnType<typeof extractJd>,
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
