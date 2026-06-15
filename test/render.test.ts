import { describe, it, expect } from "vitest";
import {
  renderResumeHtml,
  renderResumeMarkdown,
  buildResumeDocument,
  sanitizeAccent,
  type RenderInput,
} from "../src/resume/render.js";
import type { ResumeData } from "../src/types/index.js";

const resume: ResumeData = {
  fullName: "Jane Doe",
  headline: "Software Engineer",
  summary: "",
  email: "jane@example.com",
  phone: "555",
  location: "Remote",
  links: [{ label: "GitHub", url: "https://github.com/jane" }],
  skills: [],
  experiences: [
    { id: "e1", company: "Acme", title: "Engineer", startDate: "2021", endDate: "Now", bullets: ["Did things"], skills: [] },
  ],
  education: [{ institution: "MIT", degree: "BS", year: "2020" }],
  baseResumeText: "",
};

const input: RenderInput = {
  resume,
  summary: "Tailored summary.",
  orderedSkills: ["React", "Node.js"],
  experiences: [{ exp: resume.experiences[0], bullets: ["Shipped a React app"] }],
  extraSections: [{ heading: "Achievements", items: ["Spoke at a conference"] }],
};

describe("renderResumeHtml", () => {
  const html = renderResumeHtml(input);

  it("includes the name, sections and bullets", () => {
    expect(html).toContain("Jane Doe");
    expect(html).toContain("Key Skills");
    expect(html).toContain("Experience");
    expect(html).toContain("<li>Shipped a React app</li>");
  });

  it("renders extra sections like Achievements", () => {
    expect(html).toContain("Achievements");
    expect(html).toContain("<li>Spoke at a conference</li>");
  });

  it("escapes HTML to prevent markup injection", () => {
    const evil = renderResumeHtml({
      ...input,
      resume: { ...resume, fullName: "<script>alert(1)</script>" },
    });
    expect(evil).not.toContain("<script>alert(1)</script>");
    expect(evil).toContain("&lt;script&gt;");
  });
});

describe("renderResumeMarkdown", () => {
  it("still renders Markdown alongside HTML", () => {
    const md = renderResumeMarkdown(input);
    expect(md).toContain("# Jane Doe");
    expect(md).toContain("## Experience");
  });
});

describe("sanitizeAccent / buildResumeDocument", () => {
  it("accepts valid hex and rejects junk", () => {
    expect(sanitizeAccent("#a1b2c3")).toBe("#a1b2c3");
    expect(sanitizeAccent("red; } body{}")).toBe("#1f3a8a");
    expect(sanitizeAccent("javascript:alert(1)")).toBe("#1f3a8a");
  });

  it("builds a full printable document with the accent and title", () => {
    const doc = buildResumeDocument("<h1>x</h1>", { title: "Jane Doe - Resume", accent: "#123456" });
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain("<title>Jane Doe - Resume</title>");
    expect(doc).toContain("#123456");
    expect(doc).toContain("@page");
    // No auto-print script unless explicitly requested.
    expect(doc).not.toContain("window.print");
  });
});
