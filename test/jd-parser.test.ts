import { describe, it, expect } from "vitest";
import { extractJd } from "../src/resume/jd-parser.js";

const JD = `Senior Software Engineer (Remote)

We are looking for a Senior Software Engineer with 5+ years of experience.
You must have strong experience with React, TypeScript, Node.js and AWS.
Experience with Kubernetes and PostgreSQL is a plus.
Responsibilities include building scalable microservices.`;

describe("extractJd", () => {
  const a = extractJd(JD);

  it("detects skills", () => {
    expect(a.skills).toEqual(expect.arrayContaining(["React", "TypeScript", "Node.js", "AWS", "Kubernetes"]));
  });

  it("ranks skills first in keywords", () => {
    expect(a.keywords.slice(0, a.skills.length)).toEqual(a.skills);
  });

  it("detects seniority", () => {
    expect(a.seniority).toBe("Senior");
  });

  it("infers a role containing the head noun", () => {
    expect(a.role?.toLowerCase()).toContain("engineer");
  });

  it("extracts requirement sentences", () => {
    expect(a.requirements.length).toBeGreaterThan(0);
    expect(a.requirements.join(" ")).toMatch(/years|must have|experience/i);
  });

  it("parses HTML job descriptions", () => {
    const html = extractJd("<h1>Backend Engineer</h1><p>Must have <b>Go</b> and Docker.</p>");
    expect(html.skills).toEqual(expect.arrayContaining(["Go", "Docker"]));
  });
});
