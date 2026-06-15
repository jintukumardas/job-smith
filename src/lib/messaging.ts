/**
 * Typed message passing for the Background channel (popup/options -> service
 * worker via runtime.sendMessage) and the Offscreen channel (-> the WebLLM
 * offscreen document). The page<->content-script interaction does not use
 * messaging — the popup drives the content API directly via chrome.scripting so
 * it can target and aggregate across all frames.
 */
import type { ProviderState } from "../types/index.js";

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
  | { type: "SYNC_REMINDERS" };

export type BgResponse =
  | { type: "POLL_RESULT"; ok: boolean; newCount: number; total: number; error?: string }
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

export interface MapFieldsRequest {
  target: "offscreen";
  type: "MAP_FIELDS";
  fields: FieldForLlm[];
}

export interface MapFieldsResponse {
  /** ref -> value. */
  map: Record<string, string>;
  engine: "webllm" | "none";
  note?: string;
  error?: string;
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
    // Offscreen-targeted messages are handled by the offscreen document only.
    if ((req as { target?: string })?.target === "offscreen") return false;
    handler(req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ type: "ERROR", error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // keep the message channel open for async response
  });
}
