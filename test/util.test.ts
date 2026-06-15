import { describe, it, expect } from "vitest";
import {
  decodeEntities,
  stripHtml,
  hashString,
  jobId,
  tokenize,
  uniqCi,
  truncate,
  formatRelativeTime,
  collapseWhitespace,
} from "../src/lib/util.js";

describe("decodeEntities", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;c&gt; &#65; &#x42;")).toBe("a & b <c> A B");
  });
  it("leaves unknown entities intact", () => {
    expect(decodeEntities("&unknownentity;")).toBe("&unknownentity;");
  });
});

describe("stripHtml", () => {
  it("removes tags, keeps text, decodes entities", () => {
    expect(stripHtml("<p>Hello <strong>world</strong> &amp; more</p>")).toBe("Hello world & more");
  });
  it("turns block tags into line breaks and drops scripts", () => {
    const out = stripHtml("<div>One</div><script>evil()</script><div>Two</div>");
    expect(out).toContain("One");
    expect(out).toContain("Two");
    expect(out).not.toContain("evil");
  });
});

describe("collapseWhitespace", () => {
  it("collapses spaces but preserves paragraph breaks", () => {
    expect(collapseWhitespace("a   b\n\n\n c")).toBe("a b\n\nc");
  });
});

describe("hashString / jobId", () => {
  it("is deterministic", () => {
    expect(hashString("hello")).toBe(hashString("hello"));
    expect(hashString("hello")).not.toBe(hashString("world"));
  });
  it("jobId prefers url and is stable", () => {
    const a = jobId("remotive", "https://x.com/job/1", "Engineer", "Acme");
    const b = jobId("remotive", "https://x.com/job/1", "Different", "Other");
    expect(a).toBe(b); // same url -> same id
    expect(a.startsWith("remotive_")).toBe(true);
  });
});

describe("tokenize", () => {
  it("keeps tech tokens like node.js and c++", () => {
    const tokens = tokenize("We use Node.js, C++ and React!");
    expect(tokens).toContain("node.js");
    expect(tokens).toContain("c++");
    expect(tokens).toContain("react");
  });
});

describe("uniqCi", () => {
  it("dedupes case-insensitively, keeps first casing", () => {
    expect(uniqCi(["React", "react", "Vue"])).toEqual(["React", "Vue"]);
  });
});

describe("truncate", () => {
  it("adds ellipsis when over length", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("ab", 4)).toBe("ab");
  });
});

describe("formatRelativeTime", () => {
  it("formats recent times", () => {
    const now = 1_000_000_000_000;
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
});
