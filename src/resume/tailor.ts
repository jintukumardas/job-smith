/**
 * Top-level resume tailoring: parse the JD, compute skill match, run the chosen
 * engine (WebLLM with deterministic fallback), and assemble the final tailored
 * resume + diagnostics.
 *
 * A warm WebLLM engine is cached per-model so repeated tailoring in one page
 * session does not reload the model.
 */
import type { ResumeData, ResumeExperience, Settings, TailoredResume } from "../types/index.js";
import type { EngineProgress, EngineTailorResult, ResumeEngine, TailorRequest } from "./engine.js";
import { extractJd } from "./jd-parser.js";
import { enrichResume } from "./parse-resume.js";
import { curateSkills, detectSkills, sameSkill } from "./skills.js";
import { computeMatchScore, computeSkillMatch } from "./job-match.js";
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

// The pure résumé↔JD scoring lives in ./job-match (kept light so the popup can
// reuse it without the engine bundle). Re-exported here for back-compat.
export {
  computeMatchScore,
  computeSkillMatch,
  gatherResumeSkills,
  matchResumeToJd,
} from "./job-match.js";
export type { JobMatch, SkillMatch } from "./job-match.js";

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
  // Relevance order (JD-matched first), then collapse overlapping/duplicate skills
  // into one curated, capped list — not a 40-item keyword dump.
  const orderedSkills = curateSkills(uniqCi([...matched, ...llmSkills, ...ownSkills]), 20);

  // Anti-fabrication: if the summary claims a skill the candidate lacks, replace
  // it with a truthful, deterministic summary.
  let summary = content.summary.trim() || resume.summary.trim();
  const summarySkills = detectSkills(summary);
  if (missing.some((m) => summarySkills.some((s) => sameSkill(s, m)))) {
    summary = composeSummary(req);
    notes.push("Adjusted the summary to avoid claiming skills not in your resume.");
  }

  // Small models often compress a role down to 1-2 bullets or drop a role
  // entirely. Restore depth deterministically: keep the model's rephrased
  // bullets, append any real source bullets it didn't cover, and re-add any
  // whole role it omitted — so a tailored résumé never loses real experience.
  const fullExperiences = backfillExperiences(content.experiences, resume.experiences);
  const experiences: RenderedExperience[] = fullExperiences.map((exp) => ({
    exp,
    bullets: exp.bullets,
  }));

  const renderResume: ResumeData = {
    ...content,
    experiences: fullExperiences,
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

/* --------------------- bullet / role backfill (depth) -------------------- */

/** Token-set Jaccard similarity in [0,1]; 0 when either side is empty. */
function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** Index of the best-matching unused source role (by company + title), or -1. */
function matchSourceIndex(exp: ResumeExperience, source: ResumeExperience[], used: Set<number>): number {
  const key = tokenize(`${exp.company} ${exp.title}`);
  let best = -1;
  let bestScore = 0;
  source.forEach((s, i) => {
    if (used.has(i)) return;
    const score = jaccard(key, tokenize(`${s.company} ${s.title}`));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 0.34 ? best : -1;
}

/** Keep the model's bullets, then append source bullets it didn't cover. */
function mergeBullets(llmBullets: string[], sourceBullets: string[], cap = 10): string[] {
  const out = llmBullets.map((b) => b.trim()).filter(Boolean);
  const tokenSets = out.map((b) => tokenize(b));
  for (const sb of sourceBullets) {
    if (out.length >= cap) break;
    const st = tokenize(sb);
    if (tokenSets.some((t) => jaccard(t, st) >= 0.5)) continue; // already represented
    out.push(sb.trim());
    tokenSets.push(st);
  }
  return out;
}

/**
 * Reconcile the model's experiences with the real source résumé so no real
 * bullet or role is lost. Matched roles keep the model's rephrased bullets plus
 * any uncovered source bullets; roles the model dropped are appended verbatim.
 */
export function backfillExperiences(
  llm: ResumeExperience[],
  source: ResumeExperience[],
): ResumeExperience[] {
  const used = new Set<number>();
  const merged = llm.map((exp) => {
    const idx = matchSourceIndex(exp, source, used);
    if (idx < 0) return exp;
    used.add(idx);
    return { ...exp, bullets: mergeBullets(exp.bullets, source[idx].bullets) };
  });
  source.forEach((src, i) => {
    if (!used.has(i)) merged.push(src);
  });
  return merged;
}
