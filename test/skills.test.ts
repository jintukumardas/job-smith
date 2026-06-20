import { describe, it, expect } from "vitest";
import { curateSkills, detectSkills, normalizeSkill, sameSkill } from "../src/resume/skills.js";

describe("detectSkills", () => {
  it("detects skills with aliases and punctuation", () => {
    const found = detectSkills("Strong with React, TypeScript, Node.js, AWS and k8s.");
    expect(found).toContain("React");
    expect(found).toContain("TypeScript");
    expect(found).toContain("Node.js");
    expect(found).toContain("AWS");
    expect(found).toContain("Kubernetes"); // via alias "k8s"
  });

  it("does not match 'java' inside 'javascript'", () => {
    const found = detectSkills("We write JavaScript every day.");
    expect(found).toContain("JavaScript");
    expect(found).not.toContain("Java");
  });

  it("matches C++ and C# without false positives", () => {
    const found = detectSkills("Experience in C++ and C# required.");
    expect(found).toContain("C++");
    expect(found).toContain("C#");
  });

  it("returns empty for empty input", () => {
    expect(detectSkills("")).toEqual([]);
  });

  it("does not match single-letter 'C' inside hyphenated 'Objective-C'", () => {
    const found = detectSkills("We use Objective-C daily.");
    expect(found).toContain("Objective-C");
    expect(found).not.toContain("C");
  });

  it("emits each canonical skill at most once (no duplicate GraphQL)", () => {
    const found = detectSkills("GraphQL and graphql and GRAPHQL everywhere");
    expect(found.filter((s) => s === "GraphQL")).toHaveLength(1);
  });
});

describe("normalizeSkill / sameSkill", () => {
  it("normalizes aliases to canonical", () => {
    expect(normalizeSkill("k8s")).toBe("Kubernetes");
    expect(normalizeSkill("reactjs")).toBe("React");
    expect(normalizeSkill("UnknownSkill")).toBe("UnknownSkill");
  });

  it("compares skills by canonical form", () => {
    expect(sameSkill("k8s", "Kubernetes")).toBe(true);
    expect(sameSkill("React", "Vue")).toBe(false);
  });
});

describe("curateSkills (collapse overlapping skills, cap)", () => {
  it("collapses C / C++ / C/C++ into a single entry", () => {
    expect(curateSkills(["C/C++", "C++", "C"])).toEqual(["C/C++"]);
  });
  it("prefers atomic skills over an awkward compound", () => {
    const out = curateSkills([
      "High Availability & Latency Optimization",
      "High Availability",
      "Latency Optimization",
    ]);
    expect(out).toEqual(["High Availability", "Latency Optimization"]);
  });
  it("dedupes LLM Orchestration variants", () => {
    const out = curateSkills(["AI / LLM Orchestration", "LLM Orchestration", "LLM Orchestration"]);
    expect(out).toEqual(["LLM Orchestration"]);
  });
  it("keeps distinct skills and preserves order", () => {
    expect(curateSkills(["Go", "Python", "Rust"])).toEqual(["Go", "Python", "Rust"]);
  });
  it("caps the list length", () => {
    expect(curateSkills(["Go", "Python", "Rust", "Java", "Kotlin"], 3)).toHaveLength(3);
  });
});
