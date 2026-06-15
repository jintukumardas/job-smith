/**
 * Shared domain types for JobSmith.
 *
 * Everything the extension stores lives under a handful of keys in
 * `chrome.storage.local` (see {@link StorageShape}). No data ever leaves the
 * device — there is no server component.
 */

/* ------------------------------ Build-time ------------------------------- */

/** Injected by esbuild at build time (see build.mjs `define`). */
declare const __APP_VERSION__: string;
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "0.0.0";

/* -------------------------------- Settings ------------------------------- */

export interface JobSearchSettings {
  /** Master toggle for background job polling. */
  enabled: boolean;
  /** Role titles to match, e.g. ["Software Engineer", "Backend Engineer"]. */
  roles: string[];
  /** Optional must-include keywords (any-of). Empty = no keyword constraint. */
  keywords: string[];
  /** Keywords that disqualify a listing if present. */
  excludeKeywords: string[];
  /**
   * Acceptable location terms, matched case-insensitively against a listing's
   * location text, e.g. ["worldwide", "anywhere", "global", "india", "remote"].
   */
  locations: string[];
  /** When true, only listings flagged remote (or with a remote-y location) pass. */
  remoteOnly: boolean;
  /** providerId -> enabled. */
  providers: Record<string, boolean>;
  /** Desired polling cadence in minutes; clamped to provider minimums. */
  pollFrequencyMinutes: number;
}

export interface ResumeExperience {
  id: string;
  company: string;
  title: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  /** Achievement bullet points. */
  bullets: string[];
  /** Skills/technologies used in this role. */
  skills: string[];
}

export interface ResumeEducation {
  institution: string;
  degree?: string;
  year?: string;
}

export interface ResumeLink {
  label: string;
  url: string;
}

export interface ResumeData {
  fullName: string;
  headline: string;
  summary: string;
  email: string;
  phone: string;
  location: string;
  links: ResumeLink[];
  /** Master skill list (superset of per-experience skills). */
  skills: string[];
  experiences: ResumeExperience[];
  education: ResumeEducation[];
  /** Optional pasted full-resume text; a fallback corpus for tailoring. */
  baseResumeText: string;
}

export interface AutofillField {
  /** Canonical key, e.g. "firstName", "email", "linkedin". */
  key: string;
  /** Human-friendly label shown in settings. */
  label: string;
  /** Value to fill into matching form fields. */
  value: string;
  /** Extra match terms beyond the key/label. */
  aliases: string[];
  enabled: boolean;
}

export interface AutofillSettings {
  enabled: boolean;
  fields: AutofillField[];
  /**
   * Always true and not user-disableable: JobSmith fills fields but NEVER
   * submits forms. Present in the model so the UI can show it as a locked,
   * deliberate safety guarantee.
   */
  fillButNeverSubmit: true;
  /** Visually highlight fields JobSmith touched so you can review them. */
  highlightFilled: boolean;
  /** Hostnames where autofill is disabled by the user. */
  perSiteDisabled: string[];
}

export interface QuietHours {
  /** 0-23 inclusive. */
  start: number;
  /** 0-23 inclusive. */
  end: number;
}

export interface NotificationSettings {
  enabled: boolean;
  /** Only notify about listings not seen before. */
  onlyNewMatches: boolean;
  /** Max listings surfaced in a single notification batch. */
  maxPerBatch: number;
  /** Suppress notifications during these local hours (null = always on). */
  quietHours: QuietHours | null;
}

export type ResumeEngineKind = "webllm" | "deterministic";

export interface LlmSettings {
  /** Preferred engine. WebLLM falls back to deterministic if unavailable. */
  engine: ResumeEngineKind;
  /** WebLLM model id (see https://mlc.ai/models). */
  model: string;
  temperature: number;
  /** When false, never attempt WebLLM (always use the deterministic engine). */
  enabled: boolean;
}

export interface SafetySettings {
  /** Show an in-page disclosure overlay when autofilling. */
  automationDisclosure: boolean;
  /** Hard stop: disables polling, notifications and autofill when true. */
  masterKillSwitch: boolean;
  /** Enforce per-provider minimum poll intervals (locked on). */
  politePolling: true;
}

export interface Settings {
  /** Schema version for migrations. */
  schemaVersion: number;
  jobSearch: JobSearchSettings;
  resume: ResumeData;
  autofill: AutofillSettings;
  notifications: NotificationSettings;
  llm: LlmSettings;
  safety: SafetySettings;
}

/* --------------------------------- Jobs ---------------------------------- */

/** A normalized job listing produced by any provider. */
export interface Job {
  /** Stable id derived from source + url/title (see lib/util `jobId`). */
  id: string;
  /** Provider id, e.g. "remotive". */
  source: string;
  /** Human-readable source name, e.g. "Remotive". */
  sourceLabel: string;
  title: string;
  company: string;
  /** Raw location text from the source ("Worldwide", "India", ...). */
  location: string;
  remote: boolean;
  /** Canonical listing URL (used for the required backlink). */
  url: string;
  applyUrl?: string;
  /** Original description (may contain HTML). */
  description: string;
  /** Plain-text description (HTML stripped) for matching/tailoring. */
  descriptionText: string;
  tags: string[];
  salary?: string;
  /** Posting time, epoch ms, if known. */
  postedAt?: number;
  /** When JobSmith fetched it, epoch ms. */
  fetchedAt: number;
  /** Attribution text required by the source's terms, if any. */
  attribution?: string;
}

export interface ProviderState {
  lastFetch: number;
  lastError?: string;
  lastCount?: number;
}

/* ----------------------------- Applications ------------------------------ */

export type ApplicationStatus =
  | "saved"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected"
  | "withdrawn";

export const APPLICATION_STATUSES: ApplicationStatus[] = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
  "withdrawn",
];

export interface Application {
  id: string;
  jobId?: string;
  title: string;
  company: string;
  url?: string;
  status: ApplicationStatus;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  notes?: string;
  /** Follow-up reminder time, epoch ms (null/undefined = none). */
  followUpAt?: number | null;
  /** Name of the tailored resume variant used. */
  resumeVariant?: string;
  jobDescription?: string;
}

/* ------------------------------- Resume IO ------------------------------- */

/** Structured analysis of a job description. */
export interface JdAnalysis {
  /** All distinct keyword tokens, ranked by salience. */
  keywords: string[];
  /** Skills/technologies detected (subset of keywords, recognized as skills). */
  skills: string[];
  /** Sentences that look like requirements ("must have", "X+ years", ...). */
  requirements: string[];
  /** Detected seniority hint, if any. */
  seniority?: string;
  /** Inferred role title from the JD heading, if any. */
  role?: string;
}

export interface TailoredResume {
  /** Markdown rendering of the tailored resume. */
  markdown: string;
  /** Which engine produced it. */
  engine: ResumeEngineKind;
  /** Skills surfaced because they matched the JD. */
  matchedSkills: string[];
  /** JD skills not found in the resume (gaps to address). */
  missingSkills: string[];
  /** 0-100 heuristic match score. */
  matchScore: number;
  /** Tailored professional summary. */
  summary: string;
  /** Optional notes/warnings (e.g., "WebLLM unavailable, used fallback"). */
  notes: string[];
}

/* ------------------------------- Storage --------------------------------- */

export interface StorageShape {
  settings: Settings;
  /** jobId -> first-seen epoch ms (capped ring for dedupe/new detection). */
  seenJobs: Record<string, number>;
  /** Most recent matched listings, for the popup. */
  jobsCache: Job[];
  applications: Application[];
  providerState: Record<string, ProviderState>;
  /** Recent structured log entries (ring buffer). */
  logs: LogEntry[];
  /** Keys (`appId:followUpAt`) already reminded, so we don't re-notify. */
  remindedFollowUps: string[];
}

export type StorageKey = keyof StorageShape;

/* -------------------------------- Logging -------------------------------- */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}
