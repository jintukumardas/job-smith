import { describe, it, expect } from "vitest";
import {
  atsApiUrl,
  atsBoardUrl,
  canonicalSourceUrl,
  candidateAtsTokens,
  parseCustomSource,
  requiredOrigin,
} from "../src/jobs/custom-source.js";

describe("parseCustomSource", () => {
  it("detects Greenhouse board URLs and builds the JSON API endpoint", () => {
    const r = parseCustomSource("https://boards.greenhouse.io/acme");
    expect(r).toMatchObject({ kind: "greenhouse", token: "acme" });
    expect((r as { fetchUrl: string }).fetchUrl).toBe(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true",
    );
  });

  it("detects the newer job-boards.greenhouse.io host", () => {
    const r = parseCustomSource("https://job-boards.greenhouse.io/acme/jobs/123");
    expect(r).toMatchObject({ kind: "greenhouse", token: "acme" });
  });

  it("detects Lever URLs", () => {
    const r = parseCustomSource("https://jobs.lever.co/acme");
    expect(r).toMatchObject({ kind: "lever", token: "acme" });
    expect((r as { fetchUrl: string }).fetchUrl).toBe(
      "https://api.lever.co/v0/postings/acme?mode=json",
    );
  });

  it("detects Ashby URLs", () => {
    const r = parseCustomSource("https://jobs.ashbyhq.com/acme");
    expect(r).toMatchObject({ kind: "ashby", token: "acme" });
    expect((r as { fetchUrl: string }).fetchUrl).toContain(
      "https://api.ashbyhq.com/posting-api/job-board/acme",
    );
  });

  it("detects SmartRecruiters URLs", () => {
    const r = parseCustomSource("https://jobs.smartrecruiters.com/Acme");
    expect(r).toMatchObject({ kind: "smartrecruiters", token: "Acme" });
    expect((r as { fetchUrl: string }).fetchUrl).toContain(
      "https://api.smartrecruiters.com/v1/companies/Acme/postings",
    );
  });

  it("detects Workday URLs and builds the CXS endpoint (tenant + site)", () => {
    const r = parseCustomSource("https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite");
    expect(r).toMatchObject({ kind: "workday", token: "nvidia" });
    expect((r as { fetchUrl: string }).fetchUrl).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs",
    );
  });

  it("parses a Workday site even from a deep job URL", () => {
    const r = parseCustomSource(
      "https://adyen.wd3.myworkdayjobs.com/en-US/adyen_careers/job/Bengaluru/Engineer_JR-1",
    );
    expect(r).toMatchObject({ kind: "workday", token: "adyen" });
    expect((r as { fetchUrl: string }).fetchUrl).toContain("/wday/cxs/adyen/adyen_careers/jobs");
  });

  it("treats any other https URL as a generic page, fetched as-is", () => {
    const r = parseCustomSource("https://example.com/careers/feed.rss");
    expect(r).toMatchObject({ kind: "page", fetchUrl: "https://example.com/careers/feed.rss" });
  });

  it("rejects empty and non-URL input", () => {
    expect(parseCustomSource("")).toHaveProperty("error");
    expect(parseCustomSource("not a url")).toHaveProperty("error");
    expect(parseCustomSource("ftp://example.com/x")).toHaveProperty("error");
  });
});

describe("requiredOrigin", () => {
  it("returns the page origin for generic sources (needs a host permission)", () => {
    expect(requiredOrigin("https://example.com/careers/feed.rss")).toBe("https://example.com/*");
  });

  it("returns null for ATS sources (their API hosts are already permitted)", () => {
    expect(requiredOrigin("https://boards.greenhouse.io/acme")).toBeNull();
    expect(requiredOrigin("https://jobs.lever.co/acme")).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(requiredOrigin("garbage")).toBeNull();
  });
});

describe("candidateAtsTokens", () => {
  it("guesses the brand token from a careers subdomain (the Adyen case)", () => {
    expect(candidateAtsTokens("https://careers.adyen.com/vacancies?location=Bengaluru")[0]).toBe("adyen");
  });

  it("strips generic labels like jobs/www and the public suffix", () => {
    expect(candidateAtsTokens("https://jobs.stripe.com")[0]).toBe("stripe");
    expect(candidateAtsTokens("https://www.example.io/careers")[0]).toBe("example");
  });

  it("returns [] for non-URLs", () => {
    expect(candidateAtsTokens("nope")).toEqual([]);
  });
});

describe("atsApiUrl / atsBoardUrl", () => {
  it("builds the API and board URLs for each ATS", () => {
    expect(atsApiUrl("greenhouse", "adyen")).toBe(
      "https://boards-api.greenhouse.io/v1/boards/adyen/jobs?content=true",
    );
    expect(atsBoardUrl("greenhouse", "adyen")).toBe("https://boards.greenhouse.io/adyen");
    expect(atsApiUrl("smartrecruiters", "Acme")).toContain("/companies/Acme/postings");
  });
});

describe("canonicalSourceUrl", () => {
  it("normalises ATS deep links to the clean board URL", () => {
    expect(canonicalSourceUrl("https://boards.greenhouse.io/adyen/jobs/123")).toBe(
      "https://boards.greenhouse.io/adyen",
    );
    expect(canonicalSourceUrl("https://jobs.lever.co/acme/abc-def")).toBe("https://jobs.lever.co/acme");
  });

  it("keeps Workday and generic page URLs as-is", () => {
    const wd = "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite";
    expect(canonicalSourceUrl(wd)).toBe(wd);
    expect(canonicalSourceUrl("https://example.com/careers")).toBe("https://example.com/careers");
  });
});
