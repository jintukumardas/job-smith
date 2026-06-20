import { describe, it, expect } from "vitest";
import {
  backfillExperiences,
  computeSkillMatch,
  gatherResumeSkills,
  tailorResume,
} from "../src/resume/tailor.js";
import { defaultSettings } from "../src/lib/defaults.js";
import type { ResumeData, ResumeExperience } from "../src/types/index.js";

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

describe("backfillExperiences", () => {
  const exp = (over: Partial<ResumeExperience>): ResumeExperience => ({
    id: "x",
    company: "",
    title: "",
    bullets: [],
    skills: [],
    ...over,
  });

  it("restores source bullets the model dropped from a role", () => {
    const source = [
      exp({
        company: "Acme",
        title: "Engineer",
        bullets: [
          "Built REST APIs with Node.js.",
          "Rolled out a custom network library on the live trading network.",
          "Cut p99 latency by 40%.",
        ],
      }),
    ];
    const llm = [exp({ company: "Acme", title: "Engineer", bullets: ["Designed and built Node.js REST APIs."] })];
    const merged = backfillExperiences(llm, source);
    expect(merged).toHaveLength(1);
    // keeps the model's rephrased first bullet, restores the two it dropped
    expect(merged[0].bullets).toContain("Rolled out a custom network library on the live trading network.");
    expect(merged[0].bullets).toContain("Cut p99 latency by 40%.");
    expect(merged[0].bullets.length).toBeGreaterThanOrEqual(3);
  });

  it("re-adds a whole role the model omitted", () => {
    const source = [
      exp({ company: "Acme", title: "Engineer", bullets: ["Did A."] }),
      exp({ company: "Globex", title: "Senior Engineer", bullets: ["Did B."] }),
    ];
    const llm = [exp({ company: "Acme", title: "Engineer", bullets: ["Did A, tailored."] })];
    const merged = backfillExperiences(llm, source);
    expect(merged.map((e) => e.company)).toEqual(expect.arrayContaining(["Acme", "Globex"]));
  });

  it("does not duplicate bullets the model already covered", () => {
    const source = [exp({ company: "Acme", title: "Engineer", bullets: ["Built REST APIs with Node.js."] })];
    const llm = [exp({ company: "Acme", title: "Engineer", bullets: ["Built REST APIs with Node.js."] })];
    const merged = backfillExperiences(llm, source);
    expect(merged[0].bullets).toHaveLength(1);
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
