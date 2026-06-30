import { describe, it, expect } from "vitest";
import { matchesRole, matchesJob, filterJobs, type MatchCriteria } from "../src/jobs/filter.js";
import type { Job } from "../src/types/index.js";

function makeJob(partial: Partial<Job>): Job {
  return {
    id: partial.id ?? "x",
    source: "test",
    sourceLabel: "Test",
    title: partial.title ?? "Software Engineer",
    company: partial.company ?? "Acme",
    location: partial.location ?? "Worldwide",
    remote: partial.remote ?? true,
    url: partial.url ?? "https://x.com",
    description: partial.description ?? "",
    descriptionText: partial.descriptionText ?? "",
    tags: partial.tags ?? [],
    fetchedAt: partial.fetchedAt ?? Date.now(),
    ...partial,
  };
}

describe("matchesRole", () => {
  it("matches exact and related roles via head noun", () => {
    expect(matchesRole("Senior Backend Engineer", ["Software Engineer"])).toBe(true);
    expect(matchesRole("Software Engineer II", ["Software Engineer"])).toBe(true);
    expect(matchesRole("Product Manager", ["Software Engineer"])).toBe(false);
  });
  it("matches everything when no roles set", () => {
    expect(matchesRole("Anything", [])).toBe(true);
  });
});

describe("matchesJob", () => {
  const criteria: MatchCriteria = {
    roles: ["Software Engineer"],
    keywords: [],
    excludeKeywords: ["crypto"],
    locations: ["worldwide", "india", "anywhere", "remote"],
    remoteOnly: true,
  };

  it("matches a remote worldwide engineer role", () => {
    const r = matchesJob(makeJob({ title: "Backend Engineer", location: "Worldwide" }), criteria);
    expect(r.match).toBe(true);
    expect(r.score).toBeGreaterThan(0);
  });

  it("rejects non-remote when remoteOnly", () => {
    const r = matchesJob(makeJob({ remote: false, location: "Berlin" }), criteria);
    expect(r.match).toBe(false);
  });

  it("rejects USA-only locations not in the allow list", () => {
    const r = matchesJob(makeJob({ title: "Software Engineer", location: "USA Only" }), criteria);
    expect(r.match).toBe(false);
  });

  it("rejects excluded keywords", () => {
    const r = matchesJob(
      makeJob({ title: "Software Engineer", descriptionText: "build a crypto exchange" }),
      criteria,
    );
    expect(r.match).toBe(false);
  });

  it("requires at least one keyword when keywords set", () => {
    const withKw: MatchCriteria = { ...criteria, keywords: ["python"] };
    expect(matchesJob(makeJob({ descriptionText: "we use java" }), withKw).match).toBe(false);
    expect(matchesJob(makeJob({ descriptionText: "we use python" }), withKw).match).toBe(true);
  });

  it("rejects listings older than maxAgeDays (the stale-job cutoff)", () => {
    const now = 1_700_000_000_000;
    const withAge: MatchCriteria = { ...criteria, maxAgeDays: 45 };
    const old = makeJob({ fetchedAt: now, postedAt: now - 400 * 86_400_000 }); // ~13 months
    const fresh = makeJob({ fetchedAt: now, postedAt: now - 5 * 86_400_000 });
    expect(matchesJob(old, withAge).match).toBe(false);
    expect(matchesJob(fresh, withAge).match).toBe(true);
  });

  it("keeps listings with no known date even when maxAgeDays is set", () => {
    const withAge: MatchCriteria = { ...criteria, maxAgeDays: 45 };
    expect(matchesJob(makeJob({ postedAt: undefined }), withAge).match).toBe(true);
  });

  it("does not apply a cutoff when maxAgeDays is 0", () => {
    const now = 1_700_000_000_000;
    const noLimit: MatchCriteria = { ...criteria, maxAgeDays: 0 };
    const old = makeJob({ fetchedAt: now, postedAt: now - 400 * 86_400_000 });
    expect(matchesJob(old, noLimit).match).toBe(true);
  });

  it("custom-source jobs bypass role/location/remote when bypassCustom is set", () => {
    const c: MatchCriteria = {
      roles: ["Software Engineer"],
      keywords: [],
      excludeKeywords: ["crypto"],
      locations: ["india"],
      remoteOnly: true,
      bypassCustom: true,
    };
    // On-site, off-role, non-matching location — still passes because it's custom.
    const custom = makeJob({ source: "custom", title: "Group Product Manager", location: "Bengaluru", remote: false });
    expect(matchesJob(custom, c).match).toBe(true);
    // The same listing from a built-in provider is still filtered out.
    const builtin = makeJob({ source: "remotive", title: "Group Product Manager", location: "Bengaluru", remote: false });
    expect(matchesJob(builtin, c).match).toBe(false);
    // Exclude keywords still disqualify custom jobs.
    const excluded = makeJob({ source: "custom", title: "Engineer", descriptionText: "a crypto role", remote: false });
    expect(matchesJob(excluded, c).match).toBe(false);
  });

  it("custom jobs are filtered normally when bypassCustom is off", () => {
    const c: MatchCriteria = {
      roles: ["Software Engineer"],
      keywords: [],
      excludeKeywords: [],
      locations: ["india"],
      remoteOnly: true,
      bypassCustom: false,
    };
    const custom = makeJob({ source: "custom", title: "Group Product Manager", location: "Bengaluru", remote: false });
    expect(matchesJob(custom, c).match).toBe(false);
  });
});

describe("filterJobs", () => {
  const criteria: MatchCriteria = {
    roles: ["Software Engineer"],
    keywords: [],
    excludeKeywords: [],
    locations: ["worldwide", "india", "remote", "anywhere"],
    remoteOnly: true,
  };

  it("dedupes by company+title and sorts by score", () => {
    const jobs = [
      makeJob({ id: "1", title: "Software Engineer", company: "Acme", location: "India" }),
      makeJob({ id: "2", title: "software engineer", company: "acme", location: "Worldwide" }),
      makeJob({ id: "3", title: "Backend Engineer", company: "Globex", location: "Worldwide" }),
    ];
    const out = filterJobs(jobs, criteria);
    const titles = out.map((s) => `${s.job.company}:${s.job.title}`.toLowerCase());
    expect(new Set(titles).size).toBe(titles.length); // no dupes
    expect(out[0].score).toBeGreaterThanOrEqual(out[out.length - 1].score);
  });
});
