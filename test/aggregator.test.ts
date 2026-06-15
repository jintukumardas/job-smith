import { describe, it, expect } from "vitest";
import { criteriaFromSettings } from "../src/jobs/aggregator.js";
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
