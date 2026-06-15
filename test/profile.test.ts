import { describe, it, expect } from "vitest";
import {
  deriveAutofillValues,
  resolveAutofillFields,
  parseLocation,
  splitName,
} from "../src/autofill/profile.js";
import { defaultSettings } from "../src/lib/defaults.js";
import type { ResumeData } from "../src/types/index.js";

const resume: ResumeData = {
  fullName: "Priya Sharma",
  headline: "Senior Software Engineer",
  summary: "Engineer.",
  email: "priya@example.com",
  phone: "+91 90000 00000",
  location: "Bengaluru, India (Remote)",
  links: [
    { label: "GitHub", url: "https://github.com/priya" },
    { label: "LinkedIn", url: "https://www.linkedin.com/in/priya" },
    { label: "Site", url: "https://priya.dev" },
  ],
  skills: ["React", "Node.js"],
  experiences: [
    { id: "e1", company: "Flipside", title: "Senior Engineer", startDate: "2021", bullets: [], skills: [] },
  ],
  education: [],
  baseResumeText: "",
};

const NOW = Date.parse("2026-06-15T00:00:00Z");

describe("splitName", () => {
  it("splits first and last", () => {
    expect(splitName("Priya Sharma")).toEqual({ first: "Priya", last: "Sharma" });
    expect(splitName("Cher")).toEqual({ first: "Cher", last: "" });
    expect(splitName("A B C")).toEqual({ first: "A", last: "B C" });
    expect(splitName("  ")).toEqual({ first: "", last: "" });
  });
});

describe("parseLocation", () => {
  it("parses city/country and strips parentheticals", () => {
    expect(parseLocation("Bengaluru, India (Remote)")).toEqual({
      city: "Bengaluru",
      state: "",
      country: "India",
    });
  });
  it("parses city/state/country", () => {
    expect(parseLocation("San Francisco, CA, USA")).toEqual({
      city: "San Francisco",
      state: "CA",
      country: "USA",
    });
  });
  it("handles empty", () => {
    expect(parseLocation("")).toEqual({ city: "", state: "", country: "" });
  });
});

describe("deriveAutofillValues", () => {
  const d = deriveAutofillValues(resume, NOW);

  it("derives identity and contact", () => {
    expect(d.firstName).toBe("Priya");
    expect(d.lastName).toBe("Sharma");
    expect(d.fullName).toBe("Priya Sharma");
    expect(d.email).toBe("priya@example.com");
    expect(d.phone).toBe("+91 90000 00000");
  });

  it("derives location parts", () => {
    expect(d.city).toBe("Bengaluru");
    expect(d.country).toBe("India");
    expect(d.location).toContain("Bengaluru");
  });

  it("classifies links by platform", () => {
    expect(d.github).toBe("https://github.com/priya");
    expect(d.linkedin).toBe("https://www.linkedin.com/in/priya");
    expect(d.portfolio).toBe("https://priya.dev");
  });

  it("derives current role and years of experience", () => {
    expect(d.currentCompany).toBe("Flipside");
    expect(d.currentTitle).toBe("Senior Engineer");
    expect(d.yearsExperience).toBe("5"); // 2026 - 2021
  });
});

describe("resolveAutofillFields", () => {
  it("fills empty fields from the resume but keeps explicit overrides", () => {
    const settings = defaultSettings();
    settings.resume = resume;
    const emailField = settings.autofill.fields.find((f) => f.key === "email")!;
    const phoneField = settings.autofill.fields.find((f) => f.key === "phone")!;
    phoneField.value = "OVERRIDE";

    const resolved = resolveAutofillFields(settings);
    expect(resolved.find((f) => f.key === "email")!.value).toBe("priya@example.com");
    expect(resolved.find((f) => f.key === "phone")!.value).toBe("OVERRIDE");
    // original settings object is not mutated
    expect(emailField.value).toBe("");
  });
});
