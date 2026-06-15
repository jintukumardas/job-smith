/**
 * We Work Remotely — official public RSS feed (programming category).
 * https://weworkremotely.com/categories/remote-programming-jobs.rss
 *
 * Item titles are formatted "Company: Role"; `<region>` carries the location.
 * One feed is fetched to stay polite.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import { parseRss } from "../rss.js";
import type { Job } from "../../types/index.js";

const FEED_URL = "https://weworkremotely.com/categories/remote-programming-jobs.rss";
const ATTRIBUTION = "Jobs by We Work Remotely — https://weworkremotely.com";

export const wwrProvider: JobProvider = {
  id: "wwr",
  label: "We Work Remotely",
  attribution: ATTRIBUTION,
  minIntervalMinutes: 120,
  description: "Remote programming jobs via the We Work Remotely RSS feed.",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const xml = await ctx.fetchText(FEED_URL);
    const items = parseRss(xml);
    ctx.log.debug(`wwr: ${items.length} raw items`);

    return items.map((item) => {
      const { company, title } = splitTitle(item.title);
      return buildJob({
        source: "wwr",
        sourceLabel: "We Work Remotely",
        title,
        company,
        url: item.link || item.guid || "",
        description: item.description,
        location: item.region || "Remote",
        remote: true,
        tags: item.categories,
        postedAt: item.pubDate ? safeDate(item.pubDate) : undefined,
        attribution: ATTRIBUTION,
        now: ctx.now,
      });
    });
  },
};

/** "Acme Inc: Senior Backend Engineer" -> { company, title }. */
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx > 0 && idx < raw.length - 1) {
    return { company: raw.slice(0, idx).trim(), title: raw.slice(idx + 1).trim() };
  }
  return { company: "", title: raw.trim() };
}

function safeDate(value: string): number | undefined {
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}
