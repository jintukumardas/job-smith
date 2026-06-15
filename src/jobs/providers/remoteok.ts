/**
 * Remote OK — official public API: https://remoteok.com/api
 *
 * The first array element is a legal/metadata object (no `id`/`position`) and is
 * skipped. Terms REQUIRE a follow backlink to the listing URL and crediting
 * Remote OK as the source — JobSmith stores that attribution on every listing.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import type { Job } from "../../types/index.js";

interface RemoteOkJob {
  id?: string;
  slug?: string;
  epoch?: number;
  date?: string;
  company?: string;
  position?: string;
  tags?: string[];
  description?: string;
  location?: string;
  apply_url?: string;
  url?: string;
  salary_min?: number;
  salary_max?: number;
  legal?: string;
}

const ATTRIBUTION = "Jobs by Remote OK — https://remoteok.com";

export const remoteOkProvider: JobProvider = {
  id: "remoteok",
  label: "Remote OK",
  attribution: ATTRIBUTION,
  minIntervalMinutes: 360,
  description: "Remote tech jobs via the official Remote OK API (backlink required).",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const data = await ctx.fetchJson<RemoteOkJob[]>("https://remoteok.com/api");
    const list = Array.isArray(data) ? data : [];
    const jobs = list.filter((j) => j && j.id && j.position);
    ctx.log.debug(`remoteok: ${jobs.length} raw listings`);

    return jobs.map((j) =>
      buildJob({
        source: "remoteok",
        sourceLabel: "Remote OK",
        title: j.position ?? "",
        company: j.company ?? "",
        url: j.url ?? "",
        applyUrl: j.apply_url,
        description: j.description ?? "",
        location: j.location || "Remote",
        remote: true,
        tags: j.tags ?? [],
        salary: formatSalary(j.salary_min, j.salary_max),
        postedAt: parsePosted(j.epoch, j.date),
        attribution: ATTRIBUTION,
        now: ctx.now,
      }),
    );
  },
};

function formatSalary(min?: number, max?: number): string | undefined {
  const lo = typeof min === "number" && min > 0 ? min : 0;
  const hi = typeof max === "number" && max > 0 ? max : 0;
  if (!lo && !hi) return undefined;
  const fmt = (n: number) => `$${Math.round(n / 1000)}k`;
  if (lo && hi) return `${fmt(lo)}–${fmt(hi)}`;
  return fmt(lo || hi);
}

function parsePosted(epoch?: number, date?: string): number | undefined {
  if (typeof epoch === "number" && Number.isFinite(epoch)) return epoch * 1000;
  if (date) {
    const t = Date.parse(date);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}
