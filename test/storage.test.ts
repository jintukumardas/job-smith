import { describe, it, expect } from "vitest";
import { mergeSettings } from "../src/lib/storage.js";
import { defaultSettings, SCHEMA_VERSION } from "../src/lib/defaults.js";

describe("mergeSettings", () => {
  it("returns full defaults when nothing is stored", () => {
    expect(mergeSettings(undefined)).toEqual(defaultSettings());
  });

  it("overlays stored scalars while keeping default structure", () => {
    const merged = mergeSettings({
      jobSearch: { roles: ["DevOps Engineer"] } as never,
    });
    expect(merged.jobSearch.roles).toEqual(["DevOps Engineer"]);
    // Untouched nested fields fall back to defaults.
    expect(merged.jobSearch.remoteOnly).toBe(defaultSettings().jobSearch.remoteOnly);
    expect(merged.jobSearch.providers).toEqual(defaultSettings().jobSearch.providers);
    expect(merged.notifications).toEqual(defaultSettings().notifications);
  });

  it("replaces arrays wholesale rather than merging them", () => {
    const merged = mergeSettings({ jobSearch: { locations: ["india"] } as never });
    expect(merged.jobSearch.locations).toEqual(["india"]);
  });

  it("always stamps the current schema version on save-shaped objects", () => {
    expect(defaultSettings().schemaVersion).toBe(SCHEMA_VERSION);
  });
});
