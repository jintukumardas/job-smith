/**
 * Dependency-free, DOM-free HTML job extractor.
 *
 * Used both by the background poll (career-page custom sources) and by the
 * "Scan this page" action (the live page's outerHTML). The MV3 service worker
 * has no DOMParser, so — like {@link parseRss} — we parse with regex.
 *
 * Two passes, best-first:
 *   1. schema.org JSON-LD `JobPosting` blocks — the high-signal path many ATS
 *      and career pages embed (title, company, location, datePosted, url).
 *   2. Anchor heuristics — links whose href/text look like a job posting, for
 *      pages that don't publish structured data (e.g. LinkedIn/Indeed results).
 *
 * Extraction from arbitrary HTML is inherently best-effort; callers treat the
 * result as candidates, not a guarantee.
 */
import { decodeEntities, stripHtml, truncate } from "../lib/util.js";
import type { ScrapedJob } from "../types/index.js";

/** Cap so a huge page can't blow up the cache. */
const MAX_JOBS = 80;

/** href/text fragments that strongly indicate a job-posting link. */
const JOB_HREF_HINTS = [
  "/jobs/view/", // LinkedIn
  "/viewjob",
  "jk=", // Indeed
  "/job/",
  "/jobs/",
  "/careers/",
  "/career/",
  "/position",
  "/opening",
  "/vacanc",
  "/postings/",
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "smartrecruiters.com",
  "workable.com",
];

/** Generic link text that is never a real job title. */
const TITLE_STOPWORDS = new Set([
  "apply",
  "apply now",
  "learn more",
  "view all",
  "view all jobs",
  "see all jobs",
  "all jobs",
  "careers",
  "open roles",
  "open positions",
  "read more",
  "details",
  "view job",
  "save",
  "share",
]);

export function extractJobsFromHtml(html: string, baseUrl: string): ScrapedJob[] {
  if (!html) return [];
  const byUrl = new Map<string, ScrapedJob>();

  for (const job of extractJsonLd(html, baseUrl)) {
    if (job.url && !byUrl.has(job.url)) byUrl.set(job.url, job);
  }
  for (const job of extractAnchors(html, baseUrl)) {
    if (job.url && !byUrl.has(job.url)) byUrl.set(job.url, job);
  }

  return [...byUrl.values()].slice(0, MAX_JOBS);
}

/* ------------------------------- JSON-LD --------------------------------- */

function extractJsonLd(html: string, baseUrl: string): ScrapedJob[] {
  const out: ScrapedJob[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue; // malformed block — skip, don't abort the page
    }
    walkJsonLd(data, baseUrl, out);
  }
  return out;
}

function walkJsonLd(node: unknown, baseUrl: string, out: ScrapedJob[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkJsonLd(item, baseUrl, out);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj["@graph"])) walkJsonLd(obj["@graph"], baseUrl, out);

  if (isJobPostingType(obj["@type"])) {
    const job = jobFromPosting(obj, baseUrl);
    if (job) out.push(job);
  }
}

function isJobPostingType(type: unknown): boolean {
  if (typeof type === "string") return type.toLowerCase() === "jobposting";
  if (Array.isArray(type)) return type.some((t) => typeof t === "string" && t.toLowerCase() === "jobposting");
  return false;
}

function jobFromPosting(obj: Record<string, unknown>, baseUrl: string): ScrapedJob | null {
  const title = str(obj["title"]) || str(obj["name"]);
  if (!title) return null;
  const url = absolutize(str(obj["url"]) || hrefFromObject(obj["mainEntityOfPosting"]), baseUrl);
  const job: ScrapedJob = { title: truncate(title, 160), url };
  const company = orgName(obj["hiringOrganization"]);
  if (company) job.company = company;
  const location = jobLocation(obj["jobLocation"]);
  if (location) job.location = location;
  const description = str(obj["description"]);
  if (description) job.description = truncate(stripHtml(description), 6000);
  const posted = Date.parse(str(obj["datePosted"]));
  if (Number.isFinite(posted)) job.postedAt = posted;
  return job;
}

function orgName(node: unknown): string {
  if (typeof node === "string") return node.trim();
  if (node && typeof node === "object") return str((node as Record<string, unknown>)["name"]);
  return "";
}

function jobLocation(node: unknown): string {
  const first = Array.isArray(node) ? node[0] : node;
  if (!first || typeof first !== "object") return "";
  const addr = (first as Record<string, unknown>)["address"];
  if (typeof addr === "string") return addr.trim();
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    return [str(a["addressLocality"]), str(a["addressRegion"]), str(a["addressCountry"])]
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function hrefFromObject(node: unknown): string {
  if (typeof node === "string") return node;
  if (node && typeof node === "object") return str((node as Record<string, unknown>)["@id"]);
  return "";
}

/* ------------------------------- Anchors --------------------------------- */

function extractAnchors(html: string, baseUrl: string): ScrapedJob[] {
  const out: ScrapedJob[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const rawHref = decodeEntities(m[1]).trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("javascript:")) continue;
    const title = collapse(stripHtml(m[2]));
    if (!looksLikeJobLink(rawHref, title)) continue;
    const url = absolutize(rawHref, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: truncate(title, 160), url });
  }
  return out;
}

function looksLikeJobLink(href: string, title: string): boolean {
  if (title.length < 3 || title.length > 160) return false;
  if (TITLE_STOPWORDS.has(title.toLowerCase())) return false;
  const h = href.toLowerCase();
  return JOB_HREF_HINTS.some((hint) => h.includes(hint));
}

/* -------------------------------- helpers -------------------------------- */

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function absolutize(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return href;
  }
}
