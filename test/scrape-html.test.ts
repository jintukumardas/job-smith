import { describe, it, expect } from "vitest";
import { extractJobsFromHtml } from "../src/jobs/scrape-html.js";

describe("extractJobsFromHtml — JSON-LD", () => {
  const html = `
    <html><head>
      <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@type": "JobPosting",
        "title": "Senior Backend Engineer",
        "datePosted": "2026-06-01",
        "hiringOrganization": { "@type": "Organization", "name": "Acme Inc" },
        "jobLocation": { "address": { "addressLocality": "Remote", "addressCountry": "US" } },
        "url": "/jobs/senior-backend",
        "description": "<p>Build <strong>things</strong>.</p>"
      }
      </script>
    </head><body></body></html>`;

  it("extracts a JobPosting with resolved URL, company, location and date", () => {
    const jobs = extractJobsFromHtml(html, "https://acme.com/careers");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].title).toBe("Senior Backend Engineer");
    expect(jobs[0].company).toBe("Acme Inc");
    expect(jobs[0].location).toBe("Remote, US");
    expect(jobs[0].url).toBe("https://acme.com/jobs/senior-backend");
    expect(jobs[0].description).toContain("Build");
    expect(jobs[0].postedAt).toBe(Date.parse("2026-06-01"));
  });

  it("walks @graph and JobPosting arrays", () => {
    const graph = `<script type="application/ld+json">
      { "@graph": [
        { "@type": "WebSite" },
        { "@type": ["JobPosting"], "title": "Data Scientist", "url": "https://x.com/j/1" }
      ] }
    </script>`;
    const jobs = extractJobsFromHtml(graph, "https://x.com");
    expect(jobs.map((j) => j.title)).toContain("Data Scientist");
  });

  it("ignores malformed JSON-LD without throwing", () => {
    const bad = `<script type="application/ld+json">{ not json }</script>`;
    expect(extractJobsFromHtml(bad, "https://x.com")).toEqual([]);
  });
});

describe("extractJobsFromHtml — anchor heuristics", () => {
  it("picks up job links (e.g. LinkedIn /jobs/view/) and skips nav junk", () => {
    const html = `
      <a href="/about">About us</a>
      <a href="https://www.linkedin.com/jobs/view/12345">Staff Engineer at Globex</a>
      <a href="/careers/frontend-developer">Frontend Developer</a>
      <a href="/login">Apply</a>`;
    const jobs = extractJobsFromHtml(html, "https://example.com/jobs");
    const urls = jobs.map((j) => j.url);
    expect(urls).toContain("https://www.linkedin.com/jobs/view/12345");
    expect(urls).toContain("https://example.com/careers/frontend-developer");
    expect(urls).not.toContain("https://example.com/about"); // not job-ish
  });

  it("dedupes JSON-LD and anchors that point at the same URL", () => {
    const html = `
      <script type="application/ld+json">
      { "@type": "JobPosting", "title": "SRE", "url": "https://x.com/jobs/sre" }
      </script>
      <a href="https://x.com/jobs/sre">SRE</a>`;
    const jobs = extractJobsFromHtml(html, "https://x.com");
    expect(jobs.filter((j) => j.url === "https://x.com/jobs/sre")).toHaveLength(1);
  });

  it("returns nothing for a page with no jobs", () => {
    expect(extractJobsFromHtml("<html><body><p>Hello</p></body></html>", "https://x.com")).toEqual([]);
    expect(extractJobsFromHtml("", "https://x.com")).toEqual([]);
  });
});
