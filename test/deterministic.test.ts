import { describe, it, expect } from "vitest";
import { DeterministicEngine } from "../src/resume/deterministic.js";
import type { TailorRequest } from "../src/resume/engine.js";
import type { JdAnalysis, ResumeData } from "../src/types/index.js";

const resume: ResumeData = {
  fullName: "Sam Dev",
  headline: "Backend Engineer",
  summary: "Engineer who ships.",
  email: "sam@example.com",
  phone: "",
  location: "Remote",
  links: [],
  skills: ["Node.js", "PostgreSQL", "React"],
  experiences: [
    {
      id: "e1",
      company: "Acme",
      title: "Engineer",
      bullets: [
        "Maintained internal tooling in Python.",
        "Built a React dashboard used by 200 customers.",
        "Improved PostgreSQL query performance.",
      ],
      skills: ["React", "PostgreSQL"],
    },
  ],
  education: [],
  baseResumeText: "",
};

const analysis: JdAnalysis = {
  keywords: ["react", "dashboard", "frontend"],
  skills: ["React"],
  requirements: [],
};

const req: TailorRequest = {
  resume,
  jd: "We need a React engineer.",
  analysis,
  resumeSkills: ["Node.js", "PostgreSQL", "React"],
  matchedSkills: ["React"],
  missingSkills: [],
  temperature: 0.3,
};

describe("DeterministicEngine", () => {
  it("is always available", async () => {
    expect(await new DeterministicEngine().isAvailable()).toBe(true);
  });

  it("reorders bullets so the most relevant comes first", async () => {
    const out = await new DeterministicEngine().tailor(req);
    expect(out.bullets?.e1?.[0]).toContain("React");
  });

  it("composes a summary mentioning a matched skill", async () => {
    const out = await new DeterministicEngine().tailor(req);
    expect(out.summary.toLowerCase()).toContain("react");
    expect(out.notes.length).toBeGreaterThan(0);
  });

  it("never drops bullets", async () => {
    const out = await new DeterministicEngine().tailor(req);
    expect(out.bullets?.e1).toHaveLength(resume.experiences[0].bullets.length);
  });
});
