import { describe, it, expect } from "vitest";
import {
  bestFieldMatch,
  scoreFieldMatch,
  type FieldDescriptor,
  type ProfileFieldDef,
} from "../src/autofill/matcher.js";
import { DEFAULT_AUTOFILL_FIELDS } from "../src/lib/defaults.js";

const FIELDS: ProfileFieldDef[] = DEFAULT_AUTOFILL_FIELDS.map((f) => ({
  key: f.key,
  label: f.label,
  aliases: f.aliases,
}));

function desc(partial: Partial<FieldDescriptor>): FieldDescriptor {
  return {
    name: "",
    id: "",
    placeholder: "",
    ariaLabel: "",
    labelText: "",
    autocomplete: "",
    type: "text",
    testId: "",
    ...partial,
  };
}

describe("autocomplete mapping", () => {
  it("maps standard autocomplete tokens authoritatively", () => {
    expect(bestFieldMatch(desc({ autocomplete: "email" }), FIELDS)?.field.key).toBe("email");
    expect(bestFieldMatch(desc({ autocomplete: "given-name" }), FIELDS)?.field.key).toBe("firstName");
    expect(bestFieldMatch(desc({ autocomplete: "family-name" }), FIELDS)?.field.key).toBe("lastName");
    expect(bestFieldMatch(desc({ autocomplete: "tel" }), FIELDS)?.field.key).toBe("phone");
    expect(bestFieldMatch(desc({ autocomplete: "postal-code" }), FIELDS)?.field.key).toBe("postalCode");
  });
});

describe("fuzzy matching", () => {
  it("matches by name/id exactly", () => {
    expect(bestFieldMatch(desc({ name: "firstName" }), FIELDS)?.field.key).toBe("firstName");
    expect(bestFieldMatch(desc({ id: "phone" }), FIELDS)?.field.key).toBe("phone");
  });

  it("matches a bare 'name' field to fullName", () => {
    expect(bestFieldMatch(desc({ name: "name", labelText: "Name" }), FIELDS)?.field.key).toBe("fullName");
  });

  it("prefers firstName for 'First Name' label", () => {
    expect(
      bestFieldMatch(desc({ name: "first_name", labelText: "First Name" }), FIELDS)?.field.key,
    ).toBe("firstName");
  });

  it("matches LinkedIn via alias", () => {
    expect(
      bestFieldMatch(desc({ labelText: "LinkedIn Profile URL", name: "linkedin" }), FIELDS)?.field.key,
    ).toBe("linkedin");
  });

  it("returns null when nothing is confident", () => {
    expect(bestFieldMatch(desc({ name: "captcha_token", labelText: "Verify" }), FIELDS)).toBeNull();
  });

  it("handles Lever-style bracket names and org", () => {
    expect(bestFieldMatch(desc({ name: "urls[LinkedIn]" }), FIELDS)?.field.key).toBe("linkedin");
    expect(bestFieldMatch(desc({ name: "urls[GitHub]" }), FIELDS)?.field.key).toBe("github");
    expect(bestFieldMatch(desc({ name: "org", labelText: "Current company" }), FIELDS)?.field.key).toBe(
      "currentCompany",
    );
    expect(bestFieldMatch(desc({ name: "location", labelText: "Location" }), FIELDS)?.field.key).toBe(
      "location",
    );
  });

  it("matches Workday data-automation-id hooks", () => {
    expect(
      bestFieldMatch(desc({ testId: "legalNameSection_firstName" }), FIELDS)?.field.key,
    ).toBe("firstName");
    expect(bestFieldMatch(desc({ testId: "email" }), FIELDS)?.field.key).toBe("email");
  });

  it("maps autocomplete tokens with trailing whitespace", () => {
    expect(bestFieldMatch(desc({ autocomplete: "email " }), FIELDS)?.field.key).toBe("email");
  });

  it("uses input type as a tiebreaker", () => {
    expect(scoreFieldMatch(desc({ type: "email", labelText: "Contact" }), { key: "email", label: "Email", aliases: ["mail"] })).toBeGreaterThan(0);
  });
});
