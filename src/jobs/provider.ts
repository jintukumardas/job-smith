/**
 * Job provider contract.
 *
 * Each provider talks to ONE official, public job source (a documented JSON API
 * or an RSS feed) — never HTML scraping. Providers normalize their source into
 * the shared {@link Job} shape via {@link buildJob}.
 */
import type { CustomSource, Job } from "../types/index.js";
import type { Logger } from "../lib/logger.js";
import { jobId, stripHtml, truncate, uniqCi } from "../lib/util.js";

export interface ProviderContext {
  /** Role titles the user is searching for (used by APIs that support search). */
  roles: string[];
  /** Extra keywords the user wants. */
  keywords: string[];
  /** User-added career-page / feed sources (consumed by the custom provider). */
  customSources: CustomSource[];
  now: number;
  log: Logger;
  /** Fetch + parse JSON with a timeout. Throws on non-2xx. */
  fetchJson: <T = unknown>(url: string, init?: RequestInit) => Promise<T>;
  /** Fetch text (for RSS) with a timeout. Throws on non-2xx. */
  fetchText: (url: string, init?: RequestInit) => Promise<string>;
}

export interface JobProvider {
  id: string;
  label: string;
  /** Attribution text required by the source's terms of service, if any. */
  attribution?: string;
  /** Minimum minutes between fetches (terms compliance / politeness). */
  minIntervalMinutes: number;
  /** One-line description shown in settings. */
  description: string;
  fetch(ctx: ProviderContext): Promise<Job[]>;
}

const REMOTE_HINTS = [
  "remote",
  "anywhere",
  "worldwide",
  "global",
  "work from home",
  "wfh",
  "distributed",
];

export function isRemoteLocation(location: string): boolean {
  const l = location.toLowerCase();
  return REMOTE_HINTS.some((h) => l.includes(h));
}

export interface BuildJobInput {
  source: string;
  sourceLabel: string;
  title: string;
  company: string;
  url: string;
  description?: string;
  location?: string;
  remote?: boolean;
  applyUrl?: string;
  tags?: string[];
  salary?: string;
  postedAt?: number;
  attribution?: string;
  now: number;
}

/** Normalize raw provider fields into a {@link Job}. Defensive about missing data. */
export function buildJob(input: BuildJobInput): Job {
  const title = (input.title || "").trim() || "Untitled role";
  const company = (input.company || "").trim() || "Unknown company";
  const location = (input.location || "").trim();
  const description = input.description || "";
  const descriptionText = truncate(stripHtml(description), 6000);
  const remote = input.remote ?? isRemoteLocation(location);
  const job: Job = {
    id: jobId(input.source, input.url, title, company),
    source: input.source,
    sourceLabel: input.sourceLabel,
    title,
    company,
    location: location || (remote ? "Remote" : ""),
    remote,
    url: (input.url || "").trim(),
    description,
    descriptionText,
    tags: uniqCi(input.tags ?? []).slice(0, 25),
    fetchedAt: input.now,
  };
  if (input.applyUrl) job.applyUrl = input.applyUrl.trim();
  if (input.salary) job.salary = input.salary.trim();
  if (typeof input.postedAt === "number" && Number.isFinite(input.postedAt)) {
    job.postedAt = input.postedAt;
  }
  if (input.attribution) job.attribution = input.attribution;
  return job;
}
