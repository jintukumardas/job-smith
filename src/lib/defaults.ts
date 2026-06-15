/**
 * Default settings and the canonical autofill field catalogue.
 *
 * `DEFAULT_MODEL` is a small, capable WebLLM model so the first download is
 * reasonable. Users can switch to a larger or smaller model in settings.
 */
import type {
  AutofillField,
  Settings,
} from "../types/index.js";

export const SCHEMA_VERSION = 1;

/**
 * Best model for resume authoring (strong instruction-following + reliable JSON).
 * ~5GB one-time download, needs ~6GB GPU/unified memory. Falls back to the offline
 * engine on machines that can't run it. Lighter option: Qwen2.5-3B-Instruct-q4f16_1-MLC.
 * See https://mlc.ai/models for the full list of valid ids.
 */
export const DEFAULT_MODEL = "Qwen2.5-7B-Instruct-q4f16_1-MLC";

// Per-provider minimum poll intervals live on each JobProvider.minIntervalMinutes
// (the single source of truth, enforced in jobs/aggregator.ts).

export const DEFAULT_AUTOFILL_FIELDS: AutofillField[] = [
  field("firstName", "First name", ["fname", "given-name", "first"]),
  field("lastName", "Last name", ["lname", "family-name", "surname", "last"]),
  field("fullName", "Full name", ["name", "your-name", "applicant-name"]),
  field("email", "Email", ["e-mail", "email-address", "mail"]),
  field("phone", "Phone", ["mobile", "tel", "telephone", "phone-number", "contact-number"]),
  field("address", "Street address", ["street", "address-line-1", "addr"]),
  field("city", "City", ["town", "locality"]),
  field("state", "State / Region", ["region", "province"]),
  field("country", "Country", ["nation"]),
  field("postalCode", "Postal / ZIP code", ["zip", "zipcode", "pincode", "postcode"]),
  field("location", "Location", ["current-location", "present-location", "based-in", "where"]),
  field("linkedin", "LinkedIn URL", ["linked-in", "linkedin-profile", "linkedin-url"]),
  field("github", "GitHub URL", ["git-hub", "github-profile", "github-url"]),
  field("portfolio", "Portfolio / Website", ["website", "personal-site", "portfolio-url", "url"]),
  field("currentCompany", "Current company", ["employer", "company", "organization", "org"]),
  field("currentTitle", "Current title", ["job-title", "position", "role", "current-role"]),
  field("yearsExperience", "Years of experience", ["experience", "yoe", "total-experience"]),
  field("noticePeriod", "Notice period", ["availability", "notice"]),
  field("expectedSalary", "Expected salary", ["salary", "compensation", "expected-ctc", "ctc"]),
  field("workAuthorization", "Work authorization", ["visa", "authorization", "work-permit"]),
  field("willingToRelocate", "Willing to relocate", ["relocate", "relocation"]),
];

function field(key: string, label: string, aliases: string[]): AutofillField {
  return { key, label, value: "", aliases, enabled: true };
}

export function defaultSettings(): Settings {
  return {
    schemaVersion: SCHEMA_VERSION,
    jobSearch: {
      enabled: true,
      roles: ["Software Engineer"],
      keywords: [],
      excludeKeywords: [],
      locations: [
        "worldwide",
        "anywhere",
        "global",
        "remote",
        "work from anywhere",
        "india",
      ],
      remoteOnly: true,
      providers: {
        remotive: true,
        remoteok: true,
        wwr: true,
        arbeitnow: false,
        hn: false,
      },
      pollFrequencyMinutes: 180,
    },
    resume: {
      fullName: "",
      headline: "",
      summary: "",
      email: "",
      phone: "",
      location: "",
      links: [],
      skills: [],
      experiences: [],
      education: [],
      extraSections: [],
      baseResumeText: "",
    },
    autofill: {
      enabled: true,
      fields: DEFAULT_AUTOFILL_FIELDS.map((f) => ({ ...f, aliases: [...f.aliases] })),
      fillButNeverSubmit: true,
      highlightFilled: true,
      perSiteDisabled: [],
    },
    notifications: {
      enabled: true,
      onlyNewMatches: true,
      maxPerBatch: 5,
      quietHours: null,
    },
    llm: {
      engine: "webllm",
      model: DEFAULT_MODEL,
      temperature: 0.4,
      enabled: true,
    },
    safety: {
      automationDisclosure: true,
      masterKillSwitch: false,
      politePolling: true,
    },
  };
}
