/**
 * Hacker News "Ask HN: Who is hiring?" via the public Algolia HN Search API.
 *
 * Step 1: find the latest official thread (author = whoishiring).
 * Step 2: fetch the thread; each top-level comment is a posting.
 *
 * Free-text postings are messy, so parsing is heuristic (the common
 * "Company | Role | Location | REMOTE" convention). Off by default.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import { stripHtml } from "../../lib/util.js";
import type { Job } from "../../types/index.js";

interface AlgoliaSearchResponse {
  hits?: { objectID?: string; title?: string }[];
}

interface AlgoliaItem {
  id?: number;
  children?: AlgoliaItem[];
  text?: string;
  created_at_i?: number;
  author?: string;
}

const ATTRIBUTION = "Sourced from Hacker News 'Who is hiring?' — https://news.ycombinator.com";

export const hnProvider: JobProvider = {
  id: "hn",
  label: "HN Who is hiring",
  attribution: ATTRIBUTION,
  minIntervalMinutes: 720,
  description: "Postings from the monthly HN 'Who is hiring?' thread (heuristic parsing).",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const search = await ctx.fetchJson<AlgoliaSearchResponse>(
      "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring&hitsPerPage=1",
    );
    const threadId = search.hits?.[0]?.objectID;
    if (!threadId) {
      ctx.log.warn("hn: no hiring thread found");
      return [];
    }

    const thread = await ctx.fetchJson<AlgoliaItem>(
      `https://hn.algolia.com/api/v1/items/${encodeURIComponent(threadId)}`,
    );
    const comments = (thread.children ?? []).filter((c) => c && c.text);
    ctx.log.debug(`hn: ${comments.length} postings in thread ${threadId}`);

    return comments.map((c) => {
      const text = c.text ?? "";
      const parsed = parsePosting(stripHtml(text));
      return buildJob({
        source: "hn",
        sourceLabel: "HN Who is hiring",
        title: parsed.role,
        company: parsed.company,
        url: c.id ? `https://news.ycombinator.com/item?id=${c.id}` : "",
        description: text,
        location: parsed.location,
        remote: /\bremote\b/i.test(text),
        postedAt: typeof c.created_at_i === "number" ? c.created_at_i * 1000 : undefined,
        attribution: ATTRIBUTION,
        now: ctx.now,
      });
    });
  },
};

interface ParsedPosting {
  company: string;
  role: string;
  location: string;
}

/** Parse the common "Company | Role | Location | REMOTE | …" first-line format. */
function parsePosting(text: string): ParsedPosting {
  const firstLine = (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  const segments = firstLine.split(/\s*[|•–—]\s*/).map((s) => s.trim()).filter(Boolean);
  const company = segments[0] ?? "";
  const role = segments[1] ?? company ?? "Role (see description)";
  const location =
    segments.find((s) => /remote|onsite|hybrid|[A-Z]{2,}|,/.test(s) && s !== company) ??
    (/\bremote\b/i.test(firstLine) ? "Remote" : "");
  return {
    company: company || "Unknown",
    role: role.slice(0, 140),
    location,
  };
}
