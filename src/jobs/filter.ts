/**
 * Pure, unit-tested job matching & scoring.
 *
 * A listing matches when it satisfies the role, keyword, exclude and location
 * constraints. Score is a heuristic used only for ordering.
 */
import type { Job } from "../types/index.js";
import { tokenize } from "../lib/util.js";

export interface MatchCriteria {
  roles: string[];
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
  remoteOnly: boolean;
  /**
   * Hard recency cutoff in days. A listing with a known posting date older than
   * this is rejected. 0 (or omitted) disables the cutoff. Listings with no known
   * date are always kept — we can't judge their age.
   */
  maxAgeDays?: number;
  /**
   * When true, jobs from custom sources (`source === "custom"`) skip the
   * role/location/remote constraints. Exclude-keywords and the recency cutoff
   * still apply.
   */
  bypassCustom?: boolean;
}

export interface MatchResult {
  match: boolean;
  score: number;
  reasons: string[];
}

/** Seniority/qualifier tokens ignored when matching a role's "head noun". */
const ROLE_STOPWORDS = new Set([
  "senior",
  "junior",
  "lead",
  "staff",
  "principal",
  "mid",
  "entry",
  "level",
  "sr",
  "jr",
  "i",
  "ii",
  "iii",
  "the",
  "a",
  "an",
  "of",
  "and",
]);

function significantRoleTokens(role: string): string[] {
  return tokenize(role).filter((t) => !ROLE_STOPWORDS.has(t));
}

/** Does a listing title satisfy one of the desired roles? */
export function matchesRole(title: string, roles: string[]): boolean {
  if (roles.length === 0) return true;
  const lower = title.toLowerCase();
  const titleTokens = new Set(tokenize(title));
  for (const role of roles) {
    if (!role.trim()) continue;
    if (lower.includes(role.toLowerCase().trim())) return true; // exact phrase
    const tokens = significantRoleTokens(role);
    if (tokens.length === 0) continue;
    // Full subset of significant tokens present.
    if (tokens.every((t) => titleTokens.has(t))) return true;
    // Head noun (last significant token) present, e.g. "...Engineer".
    const head = tokens[tokens.length - 1];
    if (titleTokens.has(head)) return true;
  }
  return false;
}

function containsAny(haystack: string, needles: string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const n of needles) {
    const t = n.toLowerCase().trim();
    if (t && lower.includes(t)) return n;
  }
  return null;
}

export function matchesJob(job: Job, c: MatchCriteria): MatchResult {
  const reasons: string[] = [];
  let score = 0;
  const haystack = `${job.title}\n${job.descriptionText}`;

  // Exclude keywords — always disqualifying, even for custom sources.
  const excluded = containsAny(haystack, c.excludeKeywords);
  if (excluded) {
    return { match: false, score: 0, reasons: [`excluded by "${excluded}"`] };
  }

  // Hard recency cutoff: drop stale postings (e.g. a 2-year-old listing still
  // live in a feed). Only applies when we actually know the posting date — and
  // it applies to every source, custom ones included.
  if (c.maxAgeDays && c.maxAgeDays > 0 && typeof job.postedAt === "number") {
    const ageDays = (job.fetchedAt - job.postedAt) / 86_400_000;
    if (ageDays > c.maxAgeDays) {
      return { match: false, score: 0, reasons: [`older than ${c.maxAgeDays}d`] };
    }
  }

  // Custom sources the user explicitly added bypass the role/location/remote
  // search criteria — you asked to track THIS company, so show its roles.
  const bypass = !!c.bypassCustom && job.source === "custom";

  if (bypass) {
    score += 25; // base relevance so tracked-company roles rank sensibly
    reasons.push("tracked source");
  } else {
    // Remote requirement.
    if (c.remoteOnly && !job.remote) {
      return { match: false, score: 0, reasons: ["not remote"] };
    }
    // Role.
    if (!matchesRole(job.title, c.roles)) {
      return { match: false, score: 0, reasons: ["role mismatch"] };
    }
    if (c.roles.length) {
      const exactPhrase = c.roles.some((r) =>
        job.title.toLowerCase().includes(r.toLowerCase().trim()),
      );
      score += exactPhrase ? 40 : 22;
      reasons.push(exactPhrase ? "role: exact" : "role: related");
    }
    // Required keywords (any-of).
    if (c.keywords.length) {
      const hits = c.keywords.filter((k) => containsAny(haystack, [k]));
      if (hits.length === 0) {
        return { match: false, score: 0, reasons: ["no keyword match"] };
      }
      score += Math.min(30, hits.length * 12);
      reasons.push(`keywords: ${hits.join(", ")}`);
    }
    // Location (match against the listing's location text only).
    if (c.locations.length) {
      const loc = containsAny(job.location, c.locations);
      if (!loc) {
        return { match: false, score: 0, reasons: ["location mismatch"] };
      }
      const l = loc.toLowerCase();
      if (l.includes("india")) score += 20;
      else if (["worldwide", "anywhere", "global"].some((t) => l.includes(t))) score += 15;
      else score += 8;
      reasons.push(`location: ${loc}`);
    }
  }

  // Recency bonus.
  if (typeof job.postedAt === "number") {
    const ageDays = Math.max(0, (job.fetchedAt - job.postedAt) / 86_400_000);
    if (ageDays <= 3) score += 12;
    else if (ageDays <= 7) score += 6;
  }
  if (job.salary) score += 5;

  return { match: true, score: Math.min(100, score), reasons };
}

export interface ScoredJob {
  job: Job;
  score: number;
}

/** Filter, score, de-dupe (by company+title) and sort listings. */
export function filterJobs(jobs: Job[], c: MatchCriteria): ScoredJob[] {
  const scored: ScoredJob[] = [];
  for (const job of jobs) {
    const r = matchesJob(job, c);
    if (r.match) scored.push({ job, score: r.score });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.job.postedAt ?? 0) - (a.job.postedAt ?? 0);
  });
  return dedupe(scored);
}

function dedupe(scored: ScoredJob[]): ScoredJob[] {
  const seen = new Set<string>();
  const out: ScoredJob[] = [];
  for (const item of scored) {
    const key = `${item.job.company}|${item.job.title}`.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
