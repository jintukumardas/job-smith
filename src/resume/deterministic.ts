/**
 * Deterministic, offline resume tailoring. Always available — also the fallback
 * when WebLLM can't run. It does NOT invent facts: it reorders existing bullets
 * by relevance and composes a summary from the user's own data + matched skills.
 */
import type { ResumeEngine, TailorRequest, EngineTailorResult } from "./engine.js";
import { tokenize } from "../lib/util.js";

export class DeterministicEngine implements ResumeEngine {
  readonly kind = "deterministic" as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async tailor(req: TailorRequest): Promise<EngineTailorResult> {
    req.onProgress?.({ phase: "generating", message: "Tailoring locally…" });
    const summary = buildSummary(req);
    const bullets = reorderAllBullets(req);
    req.onProgress?.({ phase: "done" });
    return {
      summary,
      bullets,
      notes: ["Generated locally (deterministic engine) — facts preserved verbatim."],
    };
  }

  dispose(): void {
    /* nothing to release */
  }
}

function buildSummary(req: TailorRequest): string {
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
      `Hands-on experience with ${skillPhrase}${
        matchedSkills.length ? ", which this role calls for" : ""
      }.`,
    );
  }
  sentences.push(`Eager to bring this experience to a ${role} position.`);

  return dedupeSentences(sentences).join(" ");
}

function reorderAllBullets(req: TailorRequest): Record<string, string[]> {
  const terms = new Set<string>([
    ...req.analysis.keywords.map((k) => k.toLowerCase()),
    ...req.analysis.skills.map((s) => s.toLowerCase()),
    ...req.matchedSkills.map((s) => s.toLowerCase()),
  ]);
  const out: Record<string, string[]> = {};
  for (const exp of req.resume.experiences) {
    if (!exp.bullets.length) continue;
    const indexed = exp.bullets.map((b, i) => ({ b, i, s: bulletScore(b, terms) }));
    indexed.sort((a, z) => z.s - a.s || a.i - z.i); // relevance desc, stable
    out[exp.id] = indexed.map((x) => x.b);
  }
  return out;
}

function bulletScore(bullet: string, terms: Set<string>): number {
  let score = 0;
  for (const token of tokenize(bullet)) if (terms.has(token)) score += 1;
  return score;
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
