/**
 * Orchestrates a polling cycle: decide which providers are due (respecting their
 * minimum intervals — the anti-blacklist guarantee), fetch them in parallel,
 * normalize, then filter/score/de-dupe against the user's criteria.
 *
 * This module is side-effect free w.r.t. storage; the background service worker
 * wires in seen-job tracking, caching and notifications.
 */
import type { Job, JobSearchSettings, ProviderState, Settings } from "../types/index.js";
import { createLogger } from "../lib/logger.js";
import type { JobProvider, ProviderContext } from "./provider.js";
import { PROVIDERS } from "./providers/index.js";
import { filterJobs, type MatchCriteria, type ScoredJob } from "./filter.js";

const DEFAULT_TIMEOUT_MS = 15_000;
/** Hard floor for manual "Poll now": even forced polls stay polite. */
const MANUAL_MIN_INTERVAL_MIN = 2;

export function criteriaFromSettings(s: JobSearchSettings): MatchCriteria {
  const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);
  return {
    roles: clean(s.roles),
    keywords: clean(s.keywords),
    excludeKeywords: clean(s.excludeKeywords),
    locations: clean(s.locations),
    remoteOnly: s.remoteOnly,
  };
}

/** HTTP helpers with timeout + non-2xx -> throw. */
function createHttp(timeoutMs = DEFAULT_TIMEOUT_MS) {
  async function doFetch(url: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: { Accept: "application/json, text/xml, */*", ...(init?.headers ?? {}) },
        credentials: "omit",
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
      const res = await doFetch(url, init);
      return (await res.json()) as T;
    },
    async fetchText(url: string, init?: RequestInit): Promise<string> {
      const res = await doFetch(url, init);
      return await res.text();
    },
  };
}

export interface PollOptions {
  /** Ignore per-provider intervals (used by the "Poll now" button). */
  force?: boolean;
  now?: number;
}

export interface PollResult {
  /** Matched, scored, de-duped listings (best first). */
  matched: ScoredJob[];
  /** Provider state after this cycle (lastFetch/lastError/lastCount). */
  providerState: Record<string, ProviderState>;
  /** Providers that actually fetched this cycle. */
  ran: string[];
  /** Providers skipped because their interval had not elapsed. */
  skipped: string[];
  /** providerId -> error message for failed fetches. */
  errors: Record<string, string>;
  /** Total normalized listings fetched (before filtering). */
  fetchedCount: number;
}

export async function pollJobs(
  settings: Settings,
  prevState: Record<string, ProviderState>,
  options: PollOptions = {},
): Promise<PollResult> {
  const log = createLogger("aggregator");
  const now = options.now ?? Date.now();
  const http = createHttp();
  const criteria = criteriaFromSettings(settings.jobSearch);

  const providerState: Record<string, ProviderState> = { ...prevState };
  const ran: string[] = [];
  const skipped: string[] = [];
  const errors: Record<string, string> = {};

  const due = PROVIDERS.filter((p) => {
    if (!settings.jobSearch.providers[p.id]) return false;
    const last = prevState[p.id]?.lastFetch ?? 0;
    const elapsedMin = (now - last) / 60_000;
    // Manual polling lowers the floor but never removes it (anti-blacklist).
    const minInterval = options.force
      ? Math.min(p.minIntervalMinutes, MANUAL_MIN_INTERVAL_MIN)
      : p.minIntervalMinutes;
    const dueNow = elapsedMin >= minInterval;
    if (!dueNow) skipped.push(p.id);
    return dueNow;
  });

  const ctx: Omit<ProviderContext, "log"> = {
    roles: criteria.roles,
    keywords: criteria.keywords,
    now,
    fetchJson: http.fetchJson,
    fetchText: http.fetchText,
  };

  const settled = await Promise.allSettled(due.map((p) => fetchProvider(p, ctx)));

  const allJobs: Job[] = [];
  settled.forEach((outcome, i) => {
    const provider = due[i];
    const state: ProviderState = { ...providerState[provider.id], lastFetch: now };
    if (outcome.status === "fulfilled") {
      allJobs.push(...outcome.value);
      state.lastCount = outcome.value.length;
      delete state.lastError;
      ran.push(provider.id);
    } else {
      const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      state.lastError = msg;
      errors[provider.id] = msg;
      log.warn(`provider ${provider.id} failed`, msg);
    }
    providerState[provider.id] = state;
  });

  const matched = filterJobs(allJobs, criteria);
  log.info(
    `poll complete: ${ran.length} ran, ${allJobs.length} fetched, ${matched.length} matched`,
  );

  return { matched, providerState, ran, skipped, errors, fetchedCount: allJobs.length };
}

async function fetchProvider(
  provider: JobProvider,
  ctx: Omit<ProviderContext, "log">,
): Promise<Job[]> {
  const scoped = createLogger(`provider:${provider.id}`);
  return provider.fetch({ ...ctx, log: scoped });
}
