import { describe, it, expect } from "vitest";
import { parseRss } from "../src/jobs/rss.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>We Work Remotely</title>
    <item>
      <title>Acme Inc: Senior Backend Engineer</title>
      <region>Anywhere in the World</region>
      <category>Back-End Programming</category>
      <link>https://weworkremotely.com/remote-jobs/acme-senior-backend</link>
      <guid>https://weworkremotely.com/remote-jobs/acme-senior-backend</guid>
      <pubDate>Mon, 02 Jun 2025 10:00:00 +0000</pubDate>
      <description><![CDATA[<p>Build cool stuff with <strong>Go</strong> &amp; Kubernetes.</p>]]></description>
    </item>
    <item>
      <title>Globex: Frontend Developer</title>
      <region>USA Only</region>
      <category>Front-End Programming</category>
      <link>https://weworkremotely.com/remote-jobs/globex-frontend</link>
      <description>Plain text description with &lt;tags&gt; escaped</description>
    </item>
  </channel>
</rss>`;

describe("parseRss", () => {
  it("parses all items with fields", () => {
    const items = parseRss(SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("Acme Inc: Senior Backend Engineer");
    expect(items[0].region).toBe("Anywhere in the World");
    expect(items[0].link).toContain("acme-senior-backend");
    expect(items[0].categories).toContain("Back-End Programming");
    expect(items[0].pubDate).toContain("2025");
  });

  it("handles CDATA and entity decoding in description", () => {
    const items = parseRss(SAMPLE);
    expect(items[0].description).toContain("<strong>Go</strong>");
    expect(items[0].description).toContain("&"); // &amp; decoded
    expect(items[1].description).toContain("<tags>");
  });

  it("returns empty array for junk", () => {
    expect(parseRss("")).toEqual([]);
    expect(parseRss("not xml")).toEqual([]);
  });
});
