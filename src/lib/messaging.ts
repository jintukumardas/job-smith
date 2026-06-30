/**
 * Typed message passing for the Background channel (popup/options -> service
 * worker via runtime.sendMessage) and the Offscreen channel (-> the WebLLM
 * offscreen document). The page<->content-script interaction does not use
 * messaging — the popup drives the content API directly via chrome.scripting so
 * it can target and aggregate across all frames.
 */
import type { ProviderState, ResumeData, ScrapedJob } from "../types/index.js";

/* ------------------------------ Shared payloads --------------------------- */

export interface FilledFieldReport {
  key: string;
  label: string;
  /** A short human description of the matched control. */
  field: string;
  valuePreview: string;
}

export interface CapturedJd {
  text: string;
  title: string;
  url: string;
  company?: string;
}

/* ----------------------------- Background channel ------------------------- */

export type BgRequest =
  | { type: "POLL_NOW" }
  | { type: "GET_STATUS" }
  | { type: "RESCHEDULE" }
  | { type: "TEST_NOTIFICATION" }
  | { type: "SYNC_REMINDERS" }
  // Hand the slow on-device Smart Fill off to the service worker so it keeps
  // running — and keeps applying answers to the page — after the popup closes.
  | { type: "SMART_FILL"; tabId: number; fields: FieldForLlm[]; jd?: JdContext; highlight: boolean }
  // Jobs scraped from the page the user is viewing ("Scan this page").
  | { type: "ADD_SCANNED_JOBS"; jobs: ScrapedJob[]; sourceLabel: string }
  // Test a single custom source: fetch it, and if it's an unscrapeable SPA, try
  // to auto-detect the ATS behind it. Powers the "Test / auto-detect" button.
  | { type: "RESOLVE_CUSTOM_SOURCE"; url: string; label: string }
  // Detect the ATS behind the page the user is viewing and add it as a tracked
  // source. Powers the popup "Detect & add this page" button.
  | { type: "DETECT_AND_ADD"; pageUrl: string; candidates: string[]; label: string };

/** Port (offscreen -> service worker) that streams each answer as it's produced
 *  and, while connected, keeps the service worker alive for the whole job. */
export const SMART_FILL_PORT = "smartfill-stream";

/** Messages sent over {@link SMART_FILL_PORT}. */
export type SmartFillStream =
  | { type: "FIELD"; ref: string; value: string }
  // Heartbeat during a long single-field generation, so SW idle-timer keepalive
  // never lapses between answers. The receiver just ignores it.
  | { type: "PING" }
  | { type: "DONE"; engine: "webllm" | "none"; note?: string; error?: string };

export type BgResponse =
  | { type: "POLL_RESULT"; ok: boolean; newCount: number; total: number; error?: string }
  | { type: "SCAN_RESULT"; added: number; total: number }
  | {
      type: "RESOLVE_RESULT";
      /** True if jobs were found (directly or via the detected ATS). */
      ok: boolean;
      count: number;
      /** Sample titles for a quick sanity check. */
      samples: string[];
      /** Set when an ATS was auto-detected behind an SPA; the URL to switch to. */
      suggestedUrl?: string;
      /** Human label for the detection (e.g. "Greenhouse: adyen"). */
      detected?: string;
      error?: string;
    }
  | {
      type: "DETECT_RESULT";
      added: boolean;
      count: number;
      /** Detection label (e.g. "greenhouse: adyen"). */
      detected?: string;
      /** The board URL added as a source. */
      url?: string;
      error?: string;
    }
  | {
      type: "STATUS";
      providerState: Record<string, ProviderState>;
      jobsCount: number;
      lastPollAt: number | null;
    }
  | { type: "OK" }
  | { type: "ERROR"; error: string };

/* ------------------------------ Offscreen channel ------------------------ */

/** A page form field the deterministic matcher couldn't map, for the LLM. */
export interface FieldForLlm {
  /** Global ref: `${frameId}:${localRef}`. */
  ref: string;
  label: string;
  type: string;
  options?: string[];
}

/** The role overview captured from the page, so the model can tailor answers. */
export interface JdContext {
  text: string;
  title?: string;
  company?: string;
}

export interface MapFieldsRequest {
  target: "offscreen";
  type: "MAP_FIELDS";
  fields: FieldForLlm[];
  /** The job posting / role overview read from the page (optional). */
  jd?: JdContext;
  // The offscreen document can't read chrome.storage (Chrome restricts offscreen
  // docs to chrome.runtime), so the caller passes everything the model needs.
  resume: ResumeData;
  model: string;
  temperature: number;
}

export interface MapFieldsResponse {
  /** ref -> value. */
  map: Record<string, string>;
  engine: "webllm" | "none";
  note?: string;
  error?: string;
}

/**
 * Progress pings from the offscreen LLM host back to the popup so a long model
 * download never looks frozen. Broadcast (no response expected).
 */
export interface MapProgress {
  type: "MAP_PROGRESS";
  phase: "loading-model" | "generating";
  /** 0..1 when known (model download), omitted otherwise. */
  progress?: number;
  message: string;
  /** Set on the terminal ping so the popup can show a settled "done" state. */
  done?: boolean;
}

export function sendMapProgress(p: MapProgress): void {
  try {
    chrome.runtime.sendMessage(p, () => void chrome.runtime.lastError);
  } catch {
    /* no listener (popup closed) — safe to ignore */
  }
}

/** Listen for MAP_PROGRESS pings in the popup. Returns an unsubscribe fn. */
export function onMapProgress(handler: (p: MapProgress) => void): () => void {
  const listener = (msg: unknown): void => {
    if ((msg as MapProgress)?.type === "MAP_PROGRESS") handler(msg as MapProgress);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function sendToOffscreen(req: MapFieldsRequest): Promise<MapFieldsResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(req, (resp: MapFieldsResponse) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ map: {}, engine: "none", error: err.message ?? "unknown error" });
        else resolve(resp ?? { map: {}, engine: "none", error: "no response" });
      });
    } catch (e) {
      resolve({ map: {}, engine: "none", error: e instanceof Error ? e.message : String(e) });
    }
  });
}

export function onOffscreenMessage(
  handler: (req: MapFieldsRequest) => Promise<MapFieldsResponse>,
): void {
  chrome.runtime.onMessage.addListener((req: MapFieldsRequest, _sender, sendResponse) => {
    if (req?.target !== "offscreen") return false; // not ours
    handler(req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ map: {}, engine: "none", error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  });
}

/* -------------------------------- Senders -------------------------------- */

export function sendToBackground(req: BgRequest): Promise<BgResponse> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(req, (resp: BgResponse) => {
        const err = chrome.runtime.lastError;
        if (err) resolve({ type: "ERROR", error: err.message ?? "unknown error" });
        else resolve(resp ?? { type: "ERROR", error: "no response" });
      });
    } catch (e) {
      resolve({ type: "ERROR", error: e instanceof Error ? e.message : String(e) });
    }
  });
}

/* ------------------------------- Receivers ------------------------------- */

/** Register an async background message handler. */
export function onBackgroundMessage(
  handler: (req: BgRequest) => Promise<BgResponse>,
): void {
  chrome.runtime.onMessage.addListener((req: BgRequest, _sender, sendResponse) => {
    // Offscreen-targeted messages are handled by the offscreen document only;
    // progress pings are fire-and-forget for the popup. Ignore both here.
    const tag = req as { target?: string; type?: string };
    if (tag?.target === "offscreen" || tag?.type === "MAP_PROGRESS") return false;
    handler(req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ type: "ERROR", error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // keep the message channel open for async response
  });
}
