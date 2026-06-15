import { describe, it, expect } from "vitest";
import { parseResumeText, enrichResume } from "../src/resume/parse-resume.js";
import { defaultSettings } from "../src/lib/defaults.js";

const REAL = `Jintu Kumar Das
jintukumardas@gmail.com | GitHub | LinkedIn | Website | Bengaluru, India
PROFESSIONAL SUMMARY
Senior Software Engineer with extensive experience building high-throughput distributed systems,
optimizing performance-critical infrastructure, and shipping production AI tooling.
Worked across Go, Rust, Kubernetes, AWS, TypeScript and PostgreSQL.`;

const WITH_LINKS = `John Doe
+1 (415) 555-1234 | john.doe@example.com | https://github.com/jd | https://www.linkedin.com/in/jd
San Francisco, CA
Backend Engineer
Skills: Python, Django, Redis`;

describe("parseResumeText (real-world format with word-links)", () => {
  const p = parseResumeText(REAL);

  it("extracts the name from the first line", () => {
    expect(p.fullName).toBe("Jintu Kumar Das");
  });
  it("extracts email", () => {
    expect(p.email).toBe("jintukumardas@gmail.com");
  });
  it("extracts location from a pipe-delimited contact line", () => {
    expect(p.location).toBe("Bengaluru, India");
  });
  it("derives a headline from the summary", () => {
    expect(p.headline.toLowerCase()).toContain("engineer");
  });
  it("detects skills from the body", () => {
    expect(p.skills).toEqual(expect.arrayContaining(["Go", "Rust", "Kubernetes", "AWS", "TypeScript"]));
  });
  it("has no phone or URL links when none are present", () => {
    expect(p.phone).toBe("");
    expect(p.links).toEqual([]);
  });
});

describe("parseResumeText (with phone and URLs)", () => {
  const p = parseResumeText(WITH_LINKS);

  it("extracts a phone number", () => {
    expect(p.phone.replace(/\D/g, "")).toBe("14155551234");
  });
  it("classifies URL links", () => {
    const labels = p.links.map((l) => l.label);
    expect(labels).toContain("GitHub");
    expect(labels).toContain("LinkedIn");
  });
  it("extracts city/state location and a short headline", () => {
    expect(p.location).toBe("San Francisco, CA");
    expect(p.headline).toBe("Backend Engineer");
  });
  it("detects skills", () => {
    expect(p.skills).toEqual(expect.arrayContaining(["Python", "Django", "Redis"]));
  });
});

describe("enrichResume", () => {
  it("fills empty fields from base text but keeps existing values", () => {
    const settings = defaultSettings();
    settings.resume.baseResumeText = REAL;
    settings.resume.email = "override@me.com"; // existing value must win

    const enriched = enrichResume(settings.resume);
    expect(enriched.fullName).toBe("Jintu Kumar Das");
    expect(enriched.email).toBe("override@me.com");
    expect(enriched.skills).toEqual(expect.arrayContaining(["Go", "Rust"]));
  });

  it("is a no-op when there is no base text", () => {
    const settings = defaultSettings();
    expect(enrichResume(settings.resume)).toEqual(settings.resume);
  });
});
