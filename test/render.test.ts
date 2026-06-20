import { describe, it, expect } from "vitest";
import {
  renderResumeHtml,
  renderResumeMarkdown,
  markdownToResumeHtml,
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

describe("markdownToResumeHtml", () => {
  it("renders headings, bullets and inline formatting from Markdown", () => {
    const html = markdownToResumeHtml(renderResumeMarkdown(input));
    expect(html).toContain('<h1 class="r-name">Jane Doe</h1>');
    expect(html).toContain('<div class="r-headline">Software Engineer</div>');
    expect(html).toContain("<h2>Experience</h2>");
    expect(html).toContain('<div class="r-exp-head">Engineer — Acme</div>');
    expect(html).toContain('<div class="r-exp-meta">2021 – Now</div>');
    expect(html).toContain("<li>Shipped a React app</li>");
    expect(html).toContain('<a href="https://github.com/jane">GitHub</a>');
  });

  it("reflects edits to the Markdown (the PDF tracks the latest text)", () => {
    const edited = renderResumeMarkdown(input).replace("Shipped a React app", "Shipped a Vue app");
    const html = markdownToResumeHtml(edited);
    expect(html).toContain("<li>Shipped a Vue app</li>");
    expect(html).not.toContain("Shipped a React app");
  });

  it("escapes HTML to prevent markup injection", () => {
    const html = markdownToResumeHtml("# <script>alert(1)</script>\n\n- safe");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
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
