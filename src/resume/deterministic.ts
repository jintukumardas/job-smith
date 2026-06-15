/**
 * Deterministic, offline resume tailoring — the always-available fallback when
 * WebLLM can't run. It does NOT invent facts: it reorders existing bullets by
 * relevance and composes a summary from the user's own data + matched skills.
 */
import type { ResumeEngine, TailorRequest, EngineTailorResult, TailoredContent } from "./engine.js";
import { identityFrom } from "./engine.js";
import { tokenize, uniqCi } from "../lib/util.js";

export class DeterministicEngine implements ResumeEngine {
  readonly kind = "deterministic" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async tailor(req: TailorRequest): Promise<EngineTailorResult> {
    req.onProgress?.({ phase: "generating", message: "Tailoring locally…" });
    const terms = relevanceTerms(req);
    const content: TailoredContent = {
      ...identityFrom(req.resume),
      summary: composeSummary(req),
      skills: orderSkills(req),
      experiences: req.resume.experiences.map((e) => ({
        ...e,
        bullets: reorderBullets(e.bullets, terms),
      })),
      education: req.resume.education,
    };
    req.onProgress?.({ phase: "done" });
    return {
      content,
      notes: ["Generated locally (deterministic engine) — facts preserved verbatim."],
    };
  }

  dispose(): void {
    /* nothing to release */
  }
}

/** Truthful summary from the candidate's own data + matched skills. Reusable. */
export function composeSummary(req: TailorRequest): string {
  const { resume, analysis, matchedSkills } = req;
  const role = analysis.role || resume.headline || "Software Engineer";
  const top = (matchedSkills.length ? matchedSkills : resume.skills).slice(0, 6);
  const skillPhrase = listToPhrase(top);

  const sentences: string[] = [];
  if (resume.summary.trim()) {
    sentences.push(resume.summary.trim().replace(/\s+/g, " "));
  } else if (resume.headline) {
    sentences.push(`${resume.headline} with a track record of shipping reliable software.`);
  } else {
    sentences.push("Software professional with a track record of shipping reliable software.");
  }
  if (skillPhrase) {
    sentences.push(
      `Hands-on experience with ${skillPhrase}${matchedSkills.length ? ", which this role calls for" : ""}.`,
    );
  }
  sentences.push(`Eager to bring this experience to a ${role} position.`);
  return dedupeSentences(sentences).join(" ");
}

export function orderSkills(req: TailorRequest): string[] {
  return uniqCi([...req.matchedSkills, ...req.resumeSkills, ...req.resume.skills]).slice(0, 18);
}

export function relevanceTerms(req: TailorRequest): Set<string> {
  return new Set<string>(
    [...req.analysis.keywords, ...req.analysis.skills, ...req.matchedSkills].map((t) => t.toLowerCase()),
  );
}

export function reorderBullets(bullets: string[], terms: Set<string>): string[] {
  if (bullets.length <= 1) return [...bullets];
  const indexed = bullets.map((b, i) => {
    let s = 0;
    for (const t of tokenize(b)) if (terms.has(t)) s += 1;
    return { b, i, s };
  });
  indexed.sort((a, z) => z.s - a.s || a.i - z.i);
  return indexed.map((x) => x.b);
}

function listToPhrase(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function dedupeSentences(sentences: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sentences) {
    const key = s.toLowerCase().trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s.trim());
    }
  }
  return out;
}
