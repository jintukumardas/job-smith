/**
 * Remotive — official public API: https://remotive.com/api/remote-jobs
 *
 * Terms: attribute Remotive + link back to the listing URL; do not over-poll
 * (their docs advise ~4×/day). Data is delayed ~24h. All listings are remote.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import type { Job } from "../../types/index.js";

interface RemotiveJob {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
  publication_date?: string;
  job_type?: string;
  category?: string;
  tags?: string[];
}

interface RemotiveResponse {
  jobs?: RemotiveJob[];
}

const ATTRIBUTION = "Jobs by Remotive — https://remotive.com";

export const remotiveProvider: JobProvider = {
  id: "remotive",
  label: "Remotive",
  attribution: ATTRIBUTION,
  minIntervalMinutes: 360,
  description: "Curated remote jobs via the official Remotive API (delayed ~24h).",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const search = ctx.roles[0] ?? "";
    const params = new URLSearchParams({ limit: "75" });
    if (search) params.set("search", search);
    const url = `https://remotive.com/api/remote-jobs?${params.toString()}`;

    const data = await ctx.fetchJson<RemotiveResponse>(url);
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    ctx.log.debug(`remotive: ${jobs.length} raw listings`);

    return jobs.map((j) =>
      buildJob({
        source: "remotive",
        sourceLabel: "Remotive",
        title: j.title ?? "",
        company: j.company_name ?? "",
        url: j.url ?? "",
        description: j.description ?? "",
        location: j.candidate_required_location ?? "Worldwide",
        remote: true,
        tags: dedupeTags(j.tags, j.category, j.job_type),
        salary: j.salary || undefined,
        postedAt: parseDate(j.publication_date),
        attribution: ATTRIBUTION,
        now: ctx.now,
      }),
    );
  },
};

function dedupeTags(tags?: string[], ...extra: (string | undefined)[]): string[] {
  return [...(tags ?? []), ...extra.filter((x): x is string => !!x)];
}

function parseDate(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}
