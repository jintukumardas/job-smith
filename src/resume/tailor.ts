/**
 * Top-level resume tailoring: parse the JD, compute skill match, run the chosen
 * engine (WebLLM with deterministic fallback), and assemble the final tailored
 * resume + diagnostics.
 *
 * A warm WebLLM engine is cached per-model so repeated tailoring in one page
 * session does not reload the model.
 */
import type { ResumeData, ResumeExperience, Settings, TailoredResume } from "../types/index.js";
import type { EngineProgress, ResumeEngine } from "./engine.js";
import { extractJd } from "./jd-parser.js";
import { detectSkills, normalizeSkill, sameSkill } from "./skills.js";
import { DeterministicEngine } from "./deterministic.js";
import { WebLLMEngine } from "./webllm.js";
import { renderResumeMarkdown, type RenderedExperience } from "./render.js";
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
  const analysis = extractJd(jdText);
  const { matched, missing, resumeSkills } = computeSkillMatch(resume, analysis.skills);

  const { engine, fellBack } = await resolveEngine(settings, options.forceEngine);

  let engineResult;
  try {
    engineResult = await engine.tailor({
      resume,
      jd: jdText,
      analysis,
      resumeSkills,
      matchedSkills: matched,
      missingSkills: missing,
      temperature: settings.llm.temperature,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    if (engine.kind === "webllm") {
      log.warn("WebLLM tailoring failed; retrying with deterministic engine", e);
      engineResult = await deterministic.tailor({
        resume,
        jd: jdText,
        analysis,
        resumeSkills,
        matchedSkills: matched,
        missingSkills: missing,
        temperature: settings.llm.temperature,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
      engineResult.notes.unshift("On-device model failed to run; used the offline engine instead.");
      return assemble(resume, analysis, matched, missing, resumeSkills, engineResult, "deterministic");
    }
    throw e;
  }

  const notes = [...engineResult.notes];
  if (fellBack) notes.unshift("WebLLM was unavailable; used the offline engine instead.");
  return assemble(
    resume,
    analysis,
    matched,
    missing,
    resumeSkills,
    { ...engineResult, notes },
    fellBack ? "deterministic" : engine.kind,
  );
}

/* ------------------------------- assembly -------------------------------- */

function assemble(
  resume: ResumeData,
  analysis: ReturnType<typeof extractJd>,
  matched: string[],
  missing: string[],
  resumeSkills: string[],
  engineResult: { summary: string; bullets?: Record<string, string[]>; notes: string[] },
  engineKind: "webllm" | "deterministic",
): TailoredResume {
  const terms = new Set<string>(
    [...analysis.keywords, ...analysis.skills, ...matched].map((t) => t.toLowerCase()),
  );

  const experiences: RenderedExperience[] = resume.experiences.map((exp) => ({
    exp,
    bullets: engineResult.bullets?.[exp.id] ?? reorderBullets(exp, terms),
  }));

  const orderedSkills = uniqCi([
    ...matched,
    ...resumeSkills.filter((s) => !matched.some((m) => sameSkill(m, s))),
  ]).slice(0, 18);

  const summary = engineResult.summary.trim() || resume.summary.trim();

  const markdown = renderResumeMarkdown({ resume, summary, orderedSkills, experiences });
  const matchScore = computeMatchScore(matched, analysis, resume, resumeSkills);

  return {
    markdown,
    engine: engineKind,
    matchedSkills: matched,
    missingSkills: missing,
    matchScore,
    summary,
    notes: engineResult.notes,
  };
}

function reorderBullets(exp: ResumeExperience, terms: Set<string>): string[] {
  if (exp.bullets.length <= 1) return [...exp.bullets];
  const indexed = exp.bullets.map((b, i) => {
    let s = 0;
    for (const t of tokenize(b)) if (terms.has(t)) s += 1;
    return { b, i, s };
  });
  indexed.sort((a, z) => z.s - a.s || a.i - z.i);
  return indexed.map((x) => x.b);
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
