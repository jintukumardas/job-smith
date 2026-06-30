/**
 * Custom sources — the user's own career-page / feed URLs, fetched alongside
 * the built-in providers.
 *
 * Each enabled {@link CustomSource} is resolved (see {@link parseCustomSource})
 * to a public endpoint: a Greenhouse / Lever / Ashby board JSON API, or an
 * RSS/Atom feed. Sources are fetched in parallel and a single failing source
 * never sinks the others. No HTML scraping.
 */
import { buildJob, type JobProvider, type ProviderContext } from "../provider.js";
import {
  atsApiUrl,
  atsBoardUrl,
  candidateAtsTokens,
  parseCustomSource,
  PROBE_KINDS,
  type AtsKind,
  type ResolvedSource,
} from "../custom-source.js";
import { parseRss } from "../rss.js";
import { extractJobsFromHtml } from "../scrape-html.js";
import type { CustomSource, Job } from "../../types/index.js";

export const customProvider: JobProvider = {
  id: "custom",
  label: "Custom sources",
  minIntervalMinutes: 60,
  description:
    "Your own career-page feeds (Greenhouse, Lever, Ashby, or any RSS/Atom feed). Add them below.",

  async fetch(ctx: ProviderContext): Promise<Job[]> {
    const sources = (ctx.customSources ?? []).filter((s) => s.enabled && s.url.trim());
    if (sources.length === 0) return [];

    const settled = await Promise.allSettled(sources.map((s) => fetchCustomSource(s, ctx)));
    const jobs: Job[] = [];
    settled.forEach((outcome, i) => {
      if (outcome.status === "fulfilled") {
        jobs.push(...outcome.value);
      } else {
        const msg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        ctx.log.warn(`custom source "${sources[i].label || sources[i].url}" failed`, msg);
      }
    });
    ctx.log.debug(`custom: ${jobs.length} listings from ${sources.length} source(s)`);
    return jobs;
  },
};

/** Fetch one custom source, resolving its kind from the URL. Exported so the
 *  options page can test/auto-detect a single source on demand. */
export async function fetchCustomSource(source: CustomSource, ctx: ProviderContext): Promise<Job[]> {
  const resolved = parseCustomSource(source.url);
  if ("error" in resolved) {
    throw new Error(resolved.error);
  }
  let jobs: Job[];
  switch (resolved.kind) {
    case "greenhouse":
      jobs = await fetchGreenhouse(source, resolved, ctx);
      break;
    case "lever":
      jobs = await fetchLever(source, resolved, ctx);
      break;
    case "ashby":
      jobs = await fetchAshby(source, resolved, ctx);
      break;
    case "smartrecruiters":
      jobs = await fetchSmartRecruiters(source, resolved, ctx);
      break;
    case "workday":
      jobs = await fetchWorkday(source, resolved, ctx);
      break;
    case "page":
    default:
      jobs = await fetchPage(source, resolved, ctx);
      break;
  }
  // Tag every listing with its originating source so the cache can be pruned
  // exactly when the user deletes that source (see reconcileCustomJobs).
  for (const job of jobs) job.sourceId = source.id;
  return jobs;
}

/** Fetch ATS jobs for a known kind + endpoint (used by the auto-detect probe). */
function fetchAts(kind: AtsKind, source: CustomSource, fetchUrl: string, ctx: ProviderContext): Promise<Job[]> {
  const resolved: ResolvedSource = { kind, fetchUrl };
  switch (kind) {
    case "greenhouse":
      return fetchGreenhouse(source, resolved, ctx);
    case "lever":
      return fetchLever(source, resolved, ctx);
    case "ashby":
      return fetchAshby(source, resolved, ctx);
    case "smartrecruiters":
      return fetchSmartRecruiters(source, resolved, ctx);
  }
}

export interface AtsMatch {
  kind: AtsKind;
  token: string;
  /** The canonical board URL to store back as the source URL. */
  boardUrl: string;
  count: number;
}

/**
 * When a careers page is an unscrapeable SPA, try to find the ATS behind it by
 * guessing a board token from the domain and probing each ATS API. Returns the
 * first ATS that actually has listings, or null.
 */
export async function probeAtsForUrl(url: string, ctx: ProviderContext): Promise<AtsMatch | null> {
  const tokens = candidateAtsTokens(url);
  for (const token of tokens) {
    for (const kind of PROBE_KINDS) {
      try {
        const jobs = await fetchAts(
          kind,
          { id: "probe", label: token, url, enabled: true },
          atsApiUrl(kind, token),
          ctx,
        );
        if (jobs.length > 0) {
          return { kind, token, boardUrl: atsBoardUrl(kind, token), count: jobs.length };
        }
      } catch {
        // Wrong kind/token for this candidate — keep probing.
      }
    }
  }
  return null;
}

/* --------------------------------- ATS ----------------------------------- */

interface GreenhouseResponse {
  jobs?: {
    id?: number;
    title?: string;
    absolute_url?: string;
    updated_at?: string;
    content?: string;
    location?: { name?: string };
  }[];
}

async function fetchGreenhouse(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const data = await ctx.fetchJson<GreenhouseResponse>(resolved.fetchUrl);
  const list = Array.isArray(data.jobs) ? data.jobs : [];
  const company = source.label || resolved.token || "";
  return list.map((j) =>
    buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, "Greenhouse"),
      title: j.title ?? "",
      company,
      url: j.absolute_url ?? "",
      // Greenhouse delivers `content` as HTML-escaped HTML; buildJob strips it.
      description: j.content ?? "",
      location: j.location?.name ?? "",
      postedAt: parseDate(j.updated_at),
      now: ctx.now,
    }),
  );
}

type LeverResponse = {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  description?: string;
  descriptionPlain?: string;
  createdAt?: number; // epoch ms
  categories?: { location?: string; team?: string; commitment?: string };
}[];

async function fetchLever(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const list = await ctx.fetchJson<LeverResponse>(resolved.fetchUrl);
  const arr = Array.isArray(list) ? list : [];
  const company = source.label || resolved.token || "";
  return arr.map((j) =>
    buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, "Lever"),
      title: j.text ?? "",
      company,
      url: j.hostedUrl ?? "",
      applyUrl: j.applyUrl,
      description: j.description ?? j.descriptionPlain ?? "",
      location: j.categories?.location ?? "",
      tags: [j.categories?.team, j.categories?.commitment].filter((x): x is string => !!x),
      postedAt: typeof j.createdAt === "number" && Number.isFinite(j.createdAt) ? j.createdAt : undefined,
      now: ctx.now,
    }),
  );
}

interface AshbyResponse {
  jobs?: {
    title?: string;
    location?: string;
    department?: string;
    team?: string;
    isRemote?: boolean;
    descriptionHtml?: string;
    descriptionPlain?: string;
    jobUrl?: string;
    applyUrl?: string;
    publishedAt?: string;
    employmentType?: string;
  }[];
}

async function fetchAshby(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const data = await ctx.fetchJson<AshbyResponse>(resolved.fetchUrl);
  const list = Array.isArray(data.jobs) ? data.jobs : [];
  const company = source.label || resolved.token || "";
  return list.map((j) =>
    buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, "Ashby"),
      title: j.title ?? "",
      company,
      url: j.jobUrl ?? "",
      applyUrl: j.applyUrl,
      description: j.descriptionHtml ?? j.descriptionPlain ?? "",
      location: j.location ?? "",
      remote: j.isRemote === true ? true : undefined,
      tags: [j.department, j.team, j.employmentType].filter((x): x is string => !!x),
      postedAt: parseDate(j.publishedAt),
      now: ctx.now,
    }),
  );
}

interface SmartRecruitersResponse {
  content?: {
    id?: string;
    name?: string;
    releasedDate?: string;
    company?: { identifier?: string };
    location?: { city?: string; region?: string; country?: string; remote?: boolean };
    department?: { label?: string };
    typeOfEmployment?: { label?: string };
  }[];
}

async function fetchSmartRecruiters(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const data = await ctx.fetchJson<SmartRecruitersResponse>(resolved.fetchUrl);
  const list = Array.isArray(data.content) ? data.content : [];
  const token = resolved.token || list[0]?.company?.identifier || "";
  const company = source.label || token;
  return list.map((j) => {
    const loc = j.location;
    const locationText = loc
      ? [loc.city, loc.region, loc.country].filter(Boolean).join(", ")
      : "";
    return buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, "SmartRecruiters"),
      title: j.name ?? "",
      company,
      url: j.id && token ? `https://jobs.smartrecruiters.com/${token}/${j.id}` : "",
      location: locationText,
      remote: loc?.remote === true ? true : undefined,
      tags: [j.department?.label, j.typeOfEmployment?.label].filter((x): x is string => !!x),
      postedAt: parseDate(j.releasedDate),
      now: ctx.now,
    });
  });
}

interface WorkdayResponse {
  total?: number;
  jobPostings?: {
    title?: string;
    externalPath?: string;
    locationsText?: string;
    postedOn?: string;
  }[];
}

/** Workday caps each CXS page at 20; fetch a few pages politely. */
const WORKDAY_PAGE = 20;
const WORKDAY_MAX = 60;

async function fetchWorkday(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const { origin, site } = parseCxsUrl(resolved.fetchUrl);
  const company = source.label || resolved.token || "";
  const out: Job[] = [];

  for (let offset = 0; offset < WORKDAY_MAX; offset += WORKDAY_PAGE) {
    // CXS is a POST with a search body; limit > 20 is rejected with HTTP 400.
    const data = await ctx.fetchJson<WorkdayResponse>(resolved.fetchUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset, searchText: "" }),
    });
    const list = Array.isArray(data.jobPostings) ? data.jobPostings : [];
    for (const j of list) {
      out.push(
        buildJob({
          source: "custom",
          sourceLabel: sourceLabel(source, "Workday"),
          title: j.title ?? "",
          company,
          // Public detail URL: {origin}/en-US/{site}{externalPath}.
          url: j.externalPath && origin && site ? `${origin}/en-US/${site}${j.externalPath}` : "",
          location: j.locationsText ?? "",
          postedAt: parseWorkdayPosted(j.postedOn, ctx.now),
          now: ctx.now,
        }),
      );
    }
    if (list.length < WORKDAY_PAGE) break; // last page reached
  }
  return out;
}

/** Pull origin + site back out of a /wday/cxs/{tenant}/{site}/jobs URL. */
function parseCxsUrl(fetchUrl: string): { origin: string; site: string } {
  try {
    const u = new URL(fetchUrl);
    const seg = u.pathname.split("/").filter(Boolean); // [wday, cxs, tenant, site, jobs]
    return { origin: u.origin, site: seg[3] ?? "" };
  } catch {
    return { origin: "", site: "" };
  }
}

/** Workday only exposes a relative "Posted N Days Ago" string; approximate it. */
function parseWorkdayPosted(text: string | undefined, now: number): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (t.includes("today")) return now;
  if (t.includes("yesterday")) return now - 86_400_000;
  const day = t.match(/(\d+)\+?\s*day/);
  if (day) return now - Number(day[1]) * 86_400_000;
  const week = t.match(/(\d+)\+?\s*week/);
  if (week) return now - Number(week[1]) * 7 * 86_400_000;
  const month = t.match(/(\d+)\+?\s*month/);
  if (month) return now - Number(month[1]) * 30 * 86_400_000;
  return undefined;
}

/* ----------------------------- RSS / HTML page --------------------------- */

/** A generic URL: parse as RSS/Atom if it looks like a feed, else scrape HTML. */
async function fetchPage(
  source: CustomSource,
  resolved: ResolvedSource,
  ctx: ProviderContext,
): Promise<Job[]> {
  const body = await ctx.fetchText(resolved.fetchUrl);
  if (looksLikeFeed(body)) return fromFeed(source, body, ctx);

  const scraped = extractJobsFromHtml(body, resolved.fetchUrl);
  if (scraped.length === 0) {
    throw new Error(
      "No listings in this page's HTML — it's likely a JavaScript app that loads jobs after render. " +
        "Use “Test / auto-detect” to find the ATS behind it, or open it and click “Scan this page”.",
    );
  }
  return scraped.map((j) =>
    buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, hostOf(resolved.fetchUrl)),
      title: j.title,
      company: j.company || source.label,
      url: j.url,
      description: j.description ?? "",
      location: j.location ?? "",
      postedAt: j.postedAt,
      now: ctx.now,
    }),
  );
}

function fromFeed(source: CustomSource, xml: string, ctx: ProviderContext): Job[] {
  return parseRss(xml).map((item) => {
    const { company, title } = splitTitle(item.title, source.label);
    return buildJob({
      source: "custom",
      sourceLabel: sourceLabel(source, "Feed"),
      title,
      company,
      url: item.link || item.guid || "",
      description: item.description,
      location: item.region || "",
      tags: item.categories,
      postedAt: parseDate(item.pubDate),
      now: ctx.now,
    });
  });
}

/** Cheap sniff: RSS 2.0 / Atom feeds start with these markers near the top. */
function looksLikeFeed(body: string): boolean {
  const head = body.slice(0, 1000).toLowerCase();
  return /<rss\b|<feed\b|<\?xml|<rdf:rdf\b/.test(head) && /<item\b|<entry\b/.test(body);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Career page";
  }
}

/** Many feeds title items "Company: Role"; otherwise fall back to the source label. */
function splitTitle(raw: string, fallbackCompany: string): { company: string; title: string } {
  const idx = raw.indexOf(":");
  if (idx > 0 && idx < raw.length - 1) {
    return { company: raw.slice(0, idx).trim(), title: raw.slice(idx + 1).trim() };
  }
  return { company: fallbackCompany.trim(), title: raw.trim() };
}

/* -------------------------------- helpers -------------------------------- */

/** Prefer the user's label; else name the source by its ATS/feed kind. */
function sourceLabel(source: CustomSource, kind: string): string {
  return source.label.trim() || kind;
}

function parseDate(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}
