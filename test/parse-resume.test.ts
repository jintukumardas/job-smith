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

const FULL = `Jintu Kumar Das
Senior Software Engineer
jintukumardas@gmail.com | Bengaluru, India

SKILLS
Languages: Python, Go, Rust, C++, C, TypeScript
Infra: AWS, Docker, Kubernetes, PostgreSQL, gRPC, REST
Practices: CI/CD, Machine Learning

EXPERIENCE
Senior Software Engineer — Everclear Foundation
December 2025 – April 2026 | US
- Designed a modular service architecture.

Software System Designer 2 — Advanced Micro Devices (AMD)
July 2021 – September 2023 | Bengaluru, India
- Optimized kernels achieving 10-80% speedups.

ACHIEVEMENTS
- Speaker at GopherCon India 2024.
- Top 1% open-source contributor.

EDUCATION
M.Tech in Computer Science, Amrita Vishwa Vidyapeetham (2020-2022)
B.Tech in Computer Science, Assam Don Bosco University (2015-2019)`;

describe("parseResumeText (full resume with sections)", () => {
  const p = parseResumeText(FULL);

  it("keeps the full skill list without splitting CI/CD or C++", () => {
    expect(p.skills).toEqual(expect.arrayContaining(["Rust", "C++", "C", "CI/CD", "gRPC", "REST"]));
    expect(p.skills).not.toContain("CI");
    expect(p.skills).not.toContain("CD");
  });

  it("parses experiences with title, company, location and dates", () => {
    expect(p.experiences).toHaveLength(2);
    expect(p.experiences[0]).toMatchObject({
      title: "Senior Software Engineer",
      company: "Everclear Foundation",
      location: "US",
      startDate: "December 2025",
      endDate: "April 2026",
    });
    expect(p.experiences[0].bullets.length).toBeGreaterThan(0);
    expect(p.experiences[1].company).toContain("Advanced Micro Devices");
  });

  it("parses education with year ranges", () => {
    expect(p.education[0]).toMatchObject({
      degree: "M.Tech in Computer Science",
      institution: "Amrita Vishwa Vidyapeetham",
      year: "2020-2022",
    });
  });

  it("captures extra sections like Achievements", () => {
    const ach = p.extraSections.find((s) => /achievement/i.test(s.heading));
    expect(ach).toBeTruthy();
    expect(ach!.items).toHaveLength(2);
    expect(ach!.items[0]).toContain("GopherCon");
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
