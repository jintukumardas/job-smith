/**
 * Arbeitnow — official public job-board API.
 * https://www.arbeitnow.com/api/job-board-api  (also https://documenter.getpostman.com)
 *
 * CORS-friendly, no auth. Skews toward Europe/Germany; off by default.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import type { Job } from "../../types/index.js";

interface ArbeitnowJob {
  slug?: string;
  company_name?: string;
  title?: string;
  description?: string;
  remote?: boolean;
  url?: string;
  tags?: string[];
  job_types?: string[];
  location?: string;
  created_at?: number; // unix seconds
}

interface ArbeitnowResponse {
  data?: ArbeitnowJob[];
}

const ATTRIBUTION = "Jobs by Arbeitnow — https://www.arbeitnow.com";

export const arbeitnowProvider: JobProvider = {
  id: "arbeitnow",
  label: "Arbeitnow",
  attribution: ATTRIBUTION,
  minIntervalMinutes: 180,
  description: "Open job-board API (Europe-leaning). Includes remote + on-site.",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const data = await ctx.fetchJson<ArbeitnowResponse>(
      "https://www.arbeitnow.com/api/job-board-api",
    );
    const jobs = Array.isArray(data.data) ? data.data : [];
    ctx.log.debug(`arbeitnow: ${jobs.length} raw listings`);

    return jobs.map((j) =>
      buildJob({
        source: "arbeitnow",
        sourceLabel: "Arbeitnow",
        title: j.title ?? "",
        company: j.company_name ?? "",
        url: j.url ?? (j.slug ? `https://www.arbeitnow.com/view/${j.slug}` : ""),
        description: j.description ?? "",
        location: j.location ?? "",
        remote: j.remote === true,
        tags: [...(j.tags ?? []), ...(j.job_types ?? [])],
        postedAt: typeof j.created_at === "number" ? j.created_at * 1000 : undefined,
        attribution: ATTRIBUTION,
        now: ctx.now,
      }),
    );
  },
};
