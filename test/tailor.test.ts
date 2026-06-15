import { describe, it, expect } from "vitest";
import { computeSkillMatch, gatherResumeSkills, tailorResume } from "../src/resume/tailor.js";
import { defaultSettings } from "../src/lib/defaults.js";
import type { ResumeData } from "../src/types/index.js";

const resume: ResumeData = {
  fullName: "Sam Dev",
  headline: "Software Engineer",
  summary: "Backend-leaning engineer.",
  email: "sam@example.com",
  phone: "555",
  location: "India · Remote",
  links: [{ label: "GitHub", url: "https://github.com/sam" }],
  skills: ["React", "Node.js", "PostgreSQL"],
  experiences: [
    {
      id: "e1",
      company: "Acme",
      title: "Software Engineer",
      startDate: "2021",
      endDate: "Present",
      bullets: ["Built REST APIs with Node.js.", "Shipped a React frontend."],
      skills: ["Node.js", "React"],
    },
  ],
  education: [{ institution: "IIT", degree: "B.Tech", year: "2020" }],
  baseResumeText: "Also experienced with Docker and AWS.",
};

describe("gatherResumeSkills", () => {
  it("collects skills from declarations, roles and free text", () => {
    const skills = gatherResumeSkills(resume);
    expect(skills).toEqual(expect.arrayContaining(["React", "Node.js", "PostgreSQL", "Docker", "AWS"]));
  });
});

describe("computeSkillMatch", () => {
  it("splits matched vs missing JD skills", () => {
    const { matched, missing } = computeSkillMatch(resume, ["React", "AWS", "Kubernetes"]);
    expect(matched).toEqual(expect.arrayContaining(["React", "AWS"]));
    expect(missing).toContain("Kubernetes");
    expect(missing).not.toContain("React");
  });
});

describe("tailorResume (deterministic path)", () => {
  it("produces a tailored markdown resume with diagnostics", async () => {
    const settings = defaultSettings();
    const jd =
      "Software Engineer. Must have React, Node.js and Kubernetes. 4+ years experience building APIs.";
    const result = await tailorResume(resume, jd, settings, { forceEngine: "deterministic" });

    expect(result.engine).toBe("deterministic");
    expect(result.markdown).toContain("# Sam Dev");
    expect(result.markdown).toContain("## Experience");
    expect(result.markdown).toContain("## Key Skills");
    expect(result.matchedSkills).toEqual(expect.arrayContaining(["React", "Node.js"]));
    expect(result.missingSkills).toContain("Kubernetes");
    expect(result.matchScore).toBeGreaterThanOrEqual(0);
    expect(result.matchScore).toBeLessThanOrEqual(100);
  });
});
