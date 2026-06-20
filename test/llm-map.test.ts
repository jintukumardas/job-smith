import { describe, it, expect } from "vitest";
import { isOpenEnded, cleanAnswer } from "../src/autofill/llm-map.js";
import type { FieldForLlm } from "../src/lib/messaging.js";

const f = (over: Partial<FieldForLlm>): FieldForLlm => ({ ref: "0:f0", label: "", type: "text", ...over });

describe("isOpenEnded", () => {
  it("treats textareas and questions as open-ended", () => {
    expect(isOpenEnded(f({ type: "textarea", label: "Notes" }))).toBe(true);
    expect(isOpenEnded(f({ label: "Why are you interested in this role?" }))).toBe(true);
    expect(isOpenEnded(f({ label: "Tell us about a project you're proud of" }))).toBe(true);
    expect(
      isOpenEnded(f({ label: "If there are any other links you would like us to have, list them here" })),
    ).toBe(true);
  });
  it("treats short labelled inputs and selects as NOT open-ended", () => {
    expect(isOpenEnded(f({ label: "First name" }))).toBe(false);
    expect(isOpenEnded(f({ label: "Sponsorship?", type: "select", options: ["Yes", "No"] }))).toBe(false);
  });
});

describe("cleanAnswer", () => {
  it("strips an echoed 'Answer:' prefix and wrapping quotes", () => {
    expect(cleanAnswer('Answer: "Jane Doe"', f({ label: "Full name" }))).toBe("Jane Doe");
  });
  it("drops SKIP / N/A / don't-know answers", () => {
    expect(cleanAnswer("SKIP", f({ label: "Salary" }))).toBe("");
    expect(cleanAnswer("N/A", f({ label: "Salary" }))).toBe("");
    expect(cleanAnswer("I don't know", f({ label: "Salary" }))).toBe("");
  });
  it("resolves a select answer to a real option (exact or partial)", () => {
    const sel = f({ label: "Need sponsorship?", type: "select", options: ["Yes", "No"] });
    expect(cleanAnswer("No", sel)).toBe("No");
    expect(cleanAnswer("I would choose: No, I do not need sponsorship", sel)).toBe("No");
    expect(cleanAnswer("maybe later", sel)).toBe("");
  });
  it("keeps a full open-ended answer", () => {
    const q = f({ type: "textarea", label: "Why are you interested?" });
    const ans = "I'm excited about this backend role because my Go experience maps directly to your stack.";
    expect(cleanAnswer(ans, q)).toBe(ans);
  });
  it("caps short-field answers", () => {
    const long = "x".repeat(500);
    expect(cleanAnswer(long, f({ label: "City" })).length).toBe(160);
  });
});
