import { describe, it, expect } from "vitest";
import { buildDiscoverySearches, type DiscoveryCriteria } from "../src/jobs/discovery.js";

const BASE: DiscoveryCriteria = {
  roles: ["Backend Engineer", "SRE"],
  keywords: ["Go"],
  excludeKeywords: ["crypto"],
  locations: ["remote", "India"],
  remoteOnly: true,
};

function find(label: string) {
  return buildDiscoverySearches(BASE).find((s) => s.label === label)!;
}

describe("buildDiscoverySearches", () => {
  const all = buildDiscoverySearches(BASE);

  it("produces ATS, search-engine and job-board entries", () => {
    const cats = new Set(all.map((s) => s.category));
    expect(cats.has("ATS / career pages")).toBe(true);
    expect(cats.has("Search engines")).toBe(true);
    expect(cats.has("Job boards")).toBe(true);
  });

  it("builds a Greenhouse site: dork with OR'd roles", () => {
    const gh = find("Greenhouse");
    const q = decodeURIComponent(gh.url.split("q=")[1]);
    expect(q).toContain("site:boards.greenhouse.io");
    expect(q).toContain('"Backend Engineer" OR "SRE"');
  });

  it("adds a remote clause and the keyword, and excludes terms", () => {
    const q = find("Greenhouse").query!;
    expect(q.toLowerCase()).toContain("remote");
    expect(q).toContain("Go");
    expect(q).toContain("-crypto");
  });

  it("includes a real location but drops the 'remote' synonym from the location clause", () => {
    const q = find("Greenhouse").query!;
    expect(q).toContain("India");
  });

  it("filters LinkedIn to remote when remoteOnly", () => {
    const li = find("LinkedIn Jobs");
    expect(li.url).toContain("f_WT=2");
    expect(li.url).toContain(encodeURIComponent("Backend Engineer"));
  });

  it("falls back to a default role when none given", () => {
    const q = buildDiscoverySearches({ ...BASE, roles: [] }).find((s) => s.label === "Greenhouse")!.query!;
    expect(q).toContain("Software Engineer");
  });

  it("uses real locations (not remote) when remoteOnly is false", () => {
    const off = buildDiscoverySearches({ ...BASE, remoteOnly: false, locations: ["Berlin"] });
    const li = off.find((s) => s.label === "LinkedIn Jobs")!;
    expect(li.url).toContain(encodeURIComponent("Berlin"));
    expect(li.url).not.toContain("f_WT=2");
  });

  it("produces valid absolute URLs", () => {
    for (const s of all) expect(() => new URL(s.url)).not.toThrow();
  });
});
