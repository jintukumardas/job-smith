/**
 * Detects what kind of job feed a user-pasted URL points at and derives the
 * public endpoint to fetch.
 *
 * We recognise the major ATS boards (Greenhouse, Lever, Ashby), which expose
 * official JSON board APIs. Any other URL is fetched as-is and, at fetch time,
 * auto-detected as an RSS/Atom feed or scraped as an HTML career page (the
 * "page" kind).
 *
 * Pure & unit-testable: it only parses URLs, never fetches.
 */

export type CustomSourceKind =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "smartrecruiters"
  | "workday"
  | "page";

/** ATS kinds we can probe by guessing a board token from a company domain. */
export const PROBE_KINDS = ["greenhouse", "lever", "ashby", "smartrecruiters"] as const;
export type AtsKind = (typeof PROBE_KINDS)[number];

export interface ResolvedSource {
  kind: CustomSourceKind;
  /** The endpoint to actually fetch (JSON for ATS, the URL itself for a page). */
  fetchUrl: string;
  /** ATS board token, when applicable (e.g. the company slug). */
  token?: string;
}

/**
 * Resolve a pasted career-page/feed URL into a fetchable endpoint, or return a
 * human-readable error describing why it can't be used.
 */
export function parseCustomSource(raw: string): ResolvedSource | { error: string } {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { error: "Empty URL." };

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { error: "Not a valid URL — include https://" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { error: "URL must start with http(s)://" };
  }

  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);

  // Greenhouse: boards.greenhouse.io/{token}, job-boards.greenhouse.io/{token},
  // {token}.greenhouse.io, or an embedded ?for={token}.
  if (host.endsWith("greenhouse.io")) {
    const token =
      u.searchParams.get("for") ||
      (host.endsWith(".greenhouse.io") && !host.startsWith("boards") && !host.startsWith("job-boards")
        ? host.slice(0, -".greenhouse.io".length)
        : segments[0]);
    if (!token) return { error: "Couldn't find the Greenhouse board name in that URL." };
    return {
      kind: "greenhouse",
      token,
      fetchUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    };
  }

  // Lever: jobs.lever.co/{token}
  if (host.endsWith("lever.co")) {
    const token = segments[0];
    if (!token) return { error: "Couldn't find the Lever company name in that URL." };
    return {
      kind: "lever",
      token,
      fetchUrl: `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
    };
  }

  // Ashby: jobs.ashbyhq.com/{token}
  if (host.endsWith("ashbyhq.com")) {
    const token = segments[0];
    if (!token) return { error: "Couldn't find the Ashby board name in that URL." };
    return {
      kind: "ashby",
      token,
      fetchUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`,
    };
  }

  // SmartRecruiters: jobs.smartrecruiters.com/{token} (or careers.smartrecruiters.com).
  if (host.endsWith("smartrecruiters.com")) {
    const token = segments[0];
    if (!token) return { error: "Couldn't find the SmartRecruiters company in that URL." };
    return { kind: "smartrecruiters", token, fetchUrl: atsApiUrl("smartrecruiters", token) };
  }

  // Workday: {tenant}.{dc}.myworkdayjobs.com/{lang?}/{site}[/job/...]. The public
  // listings come from the CXS endpoint: /wday/cxs/{tenant}/{site}/jobs (POST).
  if (host.endsWith("myworkdayjobs.com")) {
    const tenant = host.split(".")[0];
    if (!tenant || host.split(".").length < 3) {
      return { error: "Couldn't parse the Workday tenant from that URL." };
    }
    // Skip an optional language segment (e.g. en-US) to find the site id.
    const siteIdx = segments[0] && /^[a-z]{2}(-[a-z]{2})?$/i.test(segments[0]) ? 1 : 0;
    const site = segments[siteIdx];
    if (!site || site === "job") {
      return { error: "Open the Workday careers landing page (…/<site>) and paste that URL." };
    }
    return {
      kind: "workday",
      token: tenant,
      fetchUrl: `https://${host}/wday/cxs/${tenant}/${encodeURIComponent(site)}/jobs`,
    };
  }

  // Otherwise fetch the URL as-is and decide at fetch time whether it's an
  // RSS/Atom feed or an HTML career page to scrape.
  return { kind: "page", fetchUrl: trimmed };
}

/**
 * The origins JobSmith must be allowed to fetch for a given source. ATS sources
 * hit fixed API hosts (already in the manifest); a generic page is fetched from
 * its own host, which needs an optional host permission granted at runtime.
 */
export function requiredOrigin(raw: string): string | null {
  const resolved = parseCustomSource(raw);
  if ("error" in resolved) return null;
  if (resolved.kind !== "page") return null; // ATS hosts are in host_permissions
  try {
    return `${new URL(resolved.fetchUrl).origin}/*`;
  } catch {
    return null;
  }
}

/** Build the public JSON endpoint for an ATS kind + board token. */
export function atsApiUrl(kind: AtsKind, token: string): string {
  const t = encodeURIComponent(token);
  switch (kind) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`;
    case "smartrecruiters":
      return `https://api.smartrecruiters.com/v1/companies/${t}/postings?limit=100`;
  }
}

/** The canonical board URL for an ATS source (what we store back as the source URL). */
export function atsBoardUrl(kind: AtsKind, token: string): string {
  switch (kind) {
    case "greenhouse":
      return `https://boards.greenhouse.io/${token}`;
    case "lever":
      return `https://jobs.lever.co/${token}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${token}`;
    case "smartrecruiters":
      return `https://jobs.smartrecruiters.com/${token}`;
  }
}

/**
 * The canonical URL to store for a source. ATS links (incl. deep job links) are
 * normalised to the clean board URL; Workday and generic pages keep the URL as
 * given (it carries the tenant/site or feed location we need).
 */
export function canonicalSourceUrl(rawUrl: string): string {
  const r = parseCustomSource(rawUrl);
  if ("error" in r) return rawUrl.trim();
  if (r.kind === "greenhouse" || r.kind === "lever" || r.kind === "ashby" || r.kind === "smartrecruiters") {
    return r.token ? atsBoardUrl(r.kind, r.token) : rawUrl.trim();
  }
  return rawUrl.trim();
}

/**
 * Guess likely ATS board tokens from a careers URL's host. Most companies use
 * their brand name as the token (careers.adyen.com → "adyen"). We strip generic
 * sub-labels (careers/jobs/www…) and the public suffix, and also offer the bare
 * registrable label. Used to probe ATS APIs when a page is an unscrapeable SPA.
 */
export function candidateAtsTokens(rawUrl: string): string[] {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return [];
  }
  const generic = new Set(["careers", "career", "jobs", "job", "work", "working", "www", "en", "apply", "talent", "join"]);
  const labels = host.split(".").filter(Boolean);
  // Drop a trailing public suffix (".com", ".co.uk", ".io" …) heuristically: the
  // last 1-2 short labels. Keep it simple — we only need plausible candidates.
  const suffixLen = labels.length >= 2 && labels[labels.length - 2].length <= 3 ? 2 : 1;
  const core = labels.slice(0, Math.max(1, labels.length - suffixLen));
  const meaningful = core.filter((l) => !generic.has(l));
  const out: string[] = [];
  // The registrable label (last meaningful, e.g. "adyen") is the best guess.
  if (meaningful.length) out.push(meaningful[meaningful.length - 1]);
  // Then any other meaningful labels (e.g. a brand on a sub-domain).
  for (const l of meaningful) if (!out.includes(l)) out.push(l);
  return out;
}
