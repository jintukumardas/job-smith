import { describe, it, expect } from "vitest";
import { criteriaFromSettings, pollJobs } from "../src/jobs/aggregator.js";
import { defaultSettings } from "../src/lib/defaults.js";

describe("criteriaFromSettings", () => {
  it("strips whitespace-only entries so they don't reject every job", () => {
    const s = defaultSettings();
    s.jobSearch.roles = ["  ", "Software Engineer", " "];
    s.jobSearch.keywords = [" "];
    s.jobSearch.locations = ["  remote ", ""];
    const c = criteriaFromSettings(s.jobSearch);
    expect(c.roles).toEqual(["Software Engineer"]);
    expect(c.keywords).toEqual([]); // whitespace-only collapses to no constraint
    expect(c.locations).toEqual(["remote"]); // trimmed
  });
});

describe("pollJobs — politeness floor", () => {
  it("fetches nothing when all providers polled too recently (rapid manual refresh)", async () => {
    const s = defaultSettings();
    // Pretend every provider just fetched — within the 2-min manual floor.
    const now = 1_700_000_000_000;
    const recent: Record<string, { lastFetch: number }> = {};
    for (const id of Object.keys(s.jobSearch.providers)) recent[id] = { lastFetch: now - 30_000 };
    const res = await pollJobs(s, recent, { force: true, now });
    expect(res.fetchedCount).toBe(0); // nothing due -> caller must NOT wipe the cache
    expect(res.ran).toEqual([]);
  });
});
