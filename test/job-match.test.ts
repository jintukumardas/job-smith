import { describe, it, expect } from "vitest";
import { isResumeMatchable, matchResumeToJd } from "../src/resume/job-match.js";
import type { ResumeData } from "../src/types/index.js";

function makeResume(over: Partial<ResumeData> = {}): ResumeData {
  return {
    fullName: "Sam Dev",
    headline: "Software Engineer",
    summary: "Backend-leaning engineer.",
    email: "sam@example.com",
    phone: "555",
    location: "India · Remote",
    links: [],
    skills: ["React", "Node.js", "PostgreSQL"],
    experiences: [
      {
        id: "e1",
        company: "Acme",
        title: "Software Engineer",
        bullets: ["Built REST APIs with Node.js.", "Shipped a React frontend."],
        skills: ["Node.js", "React"],
      },
    ],
    education: [],
    baseResumeText: "Also experienced with Docker and AWS.",
    ...over,
  };
}

const JD = `Senior Software Engineer

We are looking for a React and AWS engineer. You will work with Node.js and
Kubernetes to build distributed systems. Experience with PostgreSQL required.`;

describe("matchResumeToJd", () => {
  it("scores overlap and splits matched vs missing skills", () => {
    const m = matchResumeToJd(makeResume(), JD);
    expect(m.score).toBeGreaterThan(0);
    expect(m.score).toBeLessThanOrEqual(100);
    expect(m.matched).toEqual(expect.arrayContaining(["React", "AWS", "Node.js", "PostgreSQL"]));
    expect(m.missing).toContain("Kubernetes");
    expect(m.missing).not.toContain("React");
  });

  it("ranks a strong-fit résumé above a weak-fit one for the same JD", () => {
    const strong = matchResumeToJd(makeResume(), JD);
    const weak = matchResumeToJd(
      makeResume({
        headline: "Graphic Designer",
        skills: ["Figma"],
        experiences: [{ id: "e1", company: "Studio", title: "Designer", bullets: [], skills: ["Figma"] }],
        baseResumeText: "Brand and visual design.",
      }),
      JD,
    );
    expect(strong.score).toBeGreaterThan(weak.score);
  });

  it("treats a blank résumé as unmatchable", () => {
    const blank = makeResume({
      summary: "",
      skills: [],
      experiences: [],
      baseResumeText: "",
    });
    expect(isResumeMatchable(blank)).toBe(false);
    expect(isResumeMatchable(makeResume())).toBe(true);
  });
});
