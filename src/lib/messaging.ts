/**
 * Typed message passing between extension contexts.
 *
 * Two channels:
 *  - Background: popup/options -> service worker (runtime.sendMessage).
 *  - Tab: popup/options -> injected content script (tabs.sendMessage).
 */
import type { AutofillField, ProviderState } from "../types/index.js";

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

export interface AutofillRunOptions {
  highlight: boolean;
  disclosure: boolean;
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

/* -------------------------------- Tab channel ---------------------------- */

export type TabRequest =
  | { type: "PING" }
  | { type: "AUTOFILL"; fields: AutofillField[]; options: AutofillRunOptions }
  | { type: "CAPTURE_JD" }
  | { type: "CLEAR_HIGHLIGHTS" };

export type TabResponse =
  | { type: "PONG" }
  | { type: "AUTOFILL_RESULT"; report: FilledFieldReport[]; skipped: number; siteDisabled?: boolean }
  | { type: "JD"; jd: CapturedJd }
  | { type: "OK" }
  | { type: "ERROR"; error: string };

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

export function sendToTab(tabId: number, req: TabRequest): Promise<TabResponse> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, req, (resp: TabResponse) => {
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
    handler(req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ type: "ERROR", error: e instanceof Error ? e.message : String(e) }),
      );
    return true; // keep the message channel open for async response
  });
}

/** Register an async content-script message handler. */
export function onTabMessage(handler: (req: TabRequest) => Promise<TabResponse>): void {
  chrome.runtime.onMessage.addListener((req: TabRequest, _sender, sendResponse) => {
    handler(req)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ type: "ERROR", error: e instanceof Error ? e.message : String(e) }),
      );
    return true;
  });
}
