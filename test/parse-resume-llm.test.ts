import { describe, it, expect } from "vitest";
import { parsedFromJson, mergeParsed, applyParsedToResume } from "../src/resume/parse-resume-llm.js";
import { parseResumeText } from "../src/resume/parse-resume.js";
import { defaultSettings } from "../src/lib/defaults.js";

const MODEL_JSON = `Here you go:
{
  "fullName": "Jintu Kumar Das",
  "headline": "Software Engineer",
  "email": "jintukumardas@gmail.com",
  "phone": "+91 90000 00000",
  "location": "Bengaluru, India",
  "summary": "Engineer building distributed systems.",
  "links": [{"label": "GitHub", "url": "https://github.com/jd"}],
  "skills": ["Go", "Rust", "Kubernetes"],
  "experiences": [
    {"title": "Software Engineer", "company": "Acme", "startDate": "2021", "endDate": "Present", "bullets": ["Built a Go service handling 10k rps"]}
  ],
  "education": [{"degree": "B.Tech", "institution": "IIT", "year": "2019"}],
  "extraSections": [{"heading": "Projects", "items": ["JobSmith — a browser extension"]}]
}
Done.`;

describe("parsedFromJson", () => {
  const p = parsedFromJson(MODEL_JSON);

  it("extracts JSON even with surrounding prose / no code fences", () => {
    expect(p).not.toBeNull();
  });
  it("maps scalar fields", () => {
    expect(p!.fullName).toBe("Jintu Kumar Das");
    expect(p!.email).toBe("jintukumardas@gmail.com");
    expect(p!.location).toBe("Bengaluru, India");
  });
  it("keeps the title verbatim (no inflation)", () => {
    expect(p!.headline).toBe("Software Engineer");
    expect(p!.experiences[0].title).toBe("Software Engineer");
  });
  it("maps experiences with an id and detected skills", () => {
    const exp = p!.experiences[0];
    expect(exp.id).toMatch(/^exp/);
    expect(exp.company).toBe("Acme");
    expect(exp.bullets[0]).toContain("Go service");
    expect(exp.skills).toContain("Go");
  });
  it("maps links, education and extra sections", () => {
    expect(p!.links[0]).toEqual({ label: "GitHub", url: "https://github.com/jd" });
    expect(p!.education[0].institution).toBe("IIT");
    expect(p!.extraSections[0].heading).toBe("Projects");
  });
  it("returns null for junk / empty output", () => {
    expect(parsedFromJson("no json here")).toBeNull();
    expect(parsedFromJson('{"skills": []}')).toBeNull();
  });
});

describe("mergeParsed (regex wins for contact, AI wins for understanding)", () => {
  const ai = parsedFromJson(MODEL_JSON)!;
  const det = parseResumeText(
    "Jane Roe\njane.roe@example.com | https://github.com/jane\nBackend Engineer",
  );
  const merged = mergeParsed(ai, det);

  it("prefers the regex email (never hallucinated)", () => {
    expect(merged.email).toBe("jane.roe@example.com");
  });
  it("prefers regex links when present", () => {
    expect(merged.links.some((l) => l.url.includes("github.com/jane"))).toBe(true);
  });
  it("prefers the AI name/headline/experiences", () => {
    expect(merged.fullName).toBe("Jintu Kumar Das");
    expect(merged.experiences[0].company).toBe("Acme");
  });
  it("falls back to AI contact when regex found none", () => {
    const noContact = parseResumeText("Some text with no email or links");
    const m2 = mergeParsed(ai, noContact);
    expect(m2.email).toBe("jintukumardas@gmail.com");
  });
});

describe("applyParsedToResume", () => {
  it("overwrites with non-empty parsed values and reports a change count", () => {
    const resume = defaultSettings().resume;
    const p = parsedFromJson(MODEL_JSON)!;
    const n = applyParsedToResume(resume, p);
    expect(n).toBeGreaterThan(0);
    expect(resume.fullName).toBe("Jintu Kumar Das");
    expect(resume.skills).toContain("Rust");
    expect(resume.experiences[0].company).toBe("Acme");
  });
  it("never blanks an existing value with an empty parse", () => {
    const resume = defaultSettings().resume;
    resume.fullName = "Existing Name";
    applyParsedToResume(resume, { ...parsedFromJson(MODEL_JSON)!, fullName: "" });
    expect(resume.fullName).toBe("Existing Name");
  });
});
