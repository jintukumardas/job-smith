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
 * Default on-device model: best quality that reliably runs in-browser on typical
 * hardware (~2GB download, ~3GB GPU/unified memory). Qwen2.5-3B is excellent at
 * instruction-following + structured JSON for resume authoring. If you have a
 * strong GPU (~6GB+), `Qwen2.5-7B-Instruct-q4f16_1-MLC` is higher quality. On
 * GPUs without shader-f16, use a `q4f32_1` variant. See https://mlc.ai/models.
 */
export const DEFAULT_MODEL = "Qwen2.5-3B-Instruct-q4f16_1-MLC";

export interface ModelOption {
  id: string;
  label: string;
}

/**
 * Curated models verified to exist in the pinned @mlc-ai/web-llm prebuilt config.
 * Surfaced as a dropdown so users can't pick an id the runtime doesn't know.
 */
export const AVAILABLE_MODELS: ModelOption[] = [
  { id: "Qwen2.5-3B-Instruct-q4f16_1-MLC", label: "Qwen2.5 3B — recommended (~2 GB)" },
  { id: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC", label: "Qwen2.5 1.5B — fastest (~1 GB)" },
  { id: "Qwen2.5-7B-Instruct-q4f16_1-MLC", label: "Qwen2.5 7B — best quality, strong GPU (~5 GB)" },
  { id: "Llama-3.2-3B-Instruct-q4f16_1-MLC", label: "Llama 3.2 3B (~2 GB)" },
  { id: "Llama-3.1-8B-Instruct-q4f16_1-MLC", label: "Llama 3.1 8B — strong GPU (~5 GB)" },
  { id: "Phi-3.5-mini-instruct-q4f16_1-MLC", label: "Phi-3.5 mini (~2 GB)" },
  { id: "gemma-2-2b-it-q4f16_1-MLC", label: "Gemma 2 2B (~1.5 GB)" },
  { id: "Qwen2.5-3B-Instruct-q4f32_1-MLC", label: "Qwen2.5 3B — q4f32 (GPUs without f16)" },
];

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
