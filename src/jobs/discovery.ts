/**
 * Job-discovery search builder. Turns the user's search criteria into ready-to-run
 * "Google dork" queries against ATS boards (Greenhouse/Lever/Ashby/…) and direct
 * job-board search URLs — a fast way to surface roles the polled APIs don't carry,
 * straight from company career pages.
 *
 * Pure & unit-testable: it only builds URLs; opening them is the UI's job.
 */

export interface DiscoveryCriteria {
  roles: string[];
  keywords: string[];
  excludeKeywords: string[];
  locations: string[];
  remoteOnly: boolean;
}

export interface DiscoverySearch {
  category: "ATS / career pages" | "Search engines" | "Job boards";
  label: string;
  description: string;
  url: string;
  /** The human-readable query (for dork-style searches), shown as a hint. */
  query?: string;
}

/** Location synonyms that mean "remote", not a real place. */
const REMOTE_WORDS = new Set([
  "remote",
  "worldwide",
  "anywhere",
  "global",
  "work from anywhere",
  "work from home",
  "wfh",
]);

/** ATS hosts whose public listings are reliably indexed by search engines. */
const ATS_HOSTS: { label: string; domain: string }[] = [
  { label: "Greenhouse", domain: "boards.greenhouse.io" },
  { label: "Lever", domain: "jobs.lever.co" },
  { label: "Ashby", domain: "jobs.ashbyhq.com" },
  { label: "Workable", domain: "apply.workable.com" },
  { label: "SmartRecruiters", domain: "jobs.smartrecruiters.com" },
  { label: "Workday", domain: "myworkdayjobs.com" },
];

export function buildDiscoverySearches(criteria: DiscoveryCriteria): DiscoverySearch[] {
  const roles = criteria.roles.filter(Boolean);
  const primaryRole = roles[0] ?? "Software Engineer";
  const roleClause = orClause(roles.length ? roles : [primaryRole]);
  const kwClause = criteria.keywords.length ? orClause(criteria.keywords) : "";
  const locClause = locationClause(criteria);
  const excludeClause = criteria.excludeKeywords.map((k) => `-${quote(k)}`).join(" ");

  const out: DiscoverySearch[] = [];

  // 1) ATS / career-page dorks.
  for (const { label, domain } of ATS_HOSTS) {
    const query = compact(`site:${domain} ${roleClause} ${kwClause} ${locClause} ${excludeClause}`);
    out.push({
      category: "ATS / career pages",
      label,
      description: `Open roles on ${label} career pages`,
      url: googleUrl(query),
      query,
    });
  }

  // 2) Broad search-engine dorks.
  const careersQuery = compact(
    `${roleClause} (careers OR "we're hiring" OR "join our team") ${kwClause} ${locClause} ` +
      `-site:linkedin.com -site:indeed.com ${excludeClause}`,
  );
  out.push({
    category: "Search engines",
    label: "Company career pages",
    description: "Hiring pages across the web (excludes the big aggregators)",
    url: googleUrl(careersQuery),
    query: careersQuery,
  });
  out.push({
    category: "Search engines",
    label: "Google Jobs",
    description: "Google's aggregated job listings widget",
    url: `https://www.google.com/search?q=${enc(`${primaryRole} jobs ${criteria.remoteOnly ? "remote" : firstRealLocation(criteria)}`)}&ibp=htl;jobs`,
  });
  out.push({
    category: "Search engines",
    label: "DuckDuckGo (ATS)",
    description: "Same ATS dork on a tracker-free engine",
    url: `https://duckduckgo.com/?q=${enc(compact(`(site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com) ${roleClause} ${locClause}`))}`,
  });

  // 3) Direct job-board searches.
  const loc = criteria.remoteOnly ? "Remote" : firstRealLocation(criteria) || "Remote";
  out.push({
    category: "Job boards",
    label: "LinkedIn Jobs",
    description: criteria.remoteOnly ? "Remote-filtered LinkedIn search" : "LinkedIn job search",
    url:
      `https://www.linkedin.com/jobs/search/?keywords=${enc(primaryRole)}` +
      (criteria.remoteOnly ? "&f_WT=2" : `&location=${enc(loc)}`),
  });
  out.push({
    category: "Job boards",
    label: "Wellfound (startups)",
    description: "Startup & tech roles",
    url: `https://wellfound.com/jobs?q=${enc(primaryRole)}${criteria.remoteOnly ? "&remote=true" : ""}`,
  });
  out.push({
    category: "Job boards",
    label: "Indeed",
    description: "Indeed search",
    url: `https://www.indeed.com/jobs?q=${enc(primaryRole)}&l=${enc(loc)}`,
  });

  return out;
}

/* -------------------------------- helpers -------------------------------- */

function quote(s: string): string {
  const t = s.trim();
  return /\s/.test(t) ? `"${t}"` : t;
}

/** `("Backend Engineer" OR "SRE")` — or a single quoted term. Roles/keywords are
 * always quoted so multi- and single-word titles match precisely. */
function orClause(items: string[]): string {
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return `"${cleaned[0]}"`;
  return `(${cleaned.map((s) => `"${s}"`).join(" OR ")})`;
}

function locationClause(c: DiscoveryCriteria): string {
  const parts: string[] = [];
  const real = realLocations(c.locations);
  if (c.remoteOnly || c.locations.some((l) => REMOTE_WORDS.has(l.trim().toLowerCase()))) {
    parts.push('(remote OR "work from anywhere")');
  }
  if (real.length) parts.push(orClause(real.slice(0, 3)));
  return parts.join(" ");
}

function realLocations(locations: string[]): string[] {
  return locations.map((l) => l.trim()).filter((l) => l && !REMOTE_WORDS.has(l.toLowerCase()));
}

function firstRealLocation(c: DiscoveryCriteria): string {
  return realLocations(c.locations)[0] ?? "";
}

function compact(s: string): string {
  return s.replace(/\s{2,}/g, " ").trim();
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function googleUrl(query: string): string {
  return `https://www.google.com/search?q=${enc(query)}`;
}
