/**
 * Content script — injected ON DEMAND (never statically) into the active tab and
 * ALL its frames when you click an action in the popup. It exposes a small API on
 * the isolated-world `window` so the popup can drive it via chrome.scripting and
 * aggregate results across frames (which matters for iframe-embedded ATS forms
 * like Greenhouse).
 *
 * It fills the form, captures a job description, or clears highlights. It shows a
 * visible disclosure that automation ran and NEVER submits anything.
 */
import {
  fillForm,
  clearHighlights,
  collectUnmatchedFields,
  applyValueMap,
  type FillResult,
  type CollectedField,
} from "../autofill/filler.js";
import type { AutofillField } from "../types/index.js";
import type { CapturedJd } from "../lib/messaging.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("content");

export interface FillPayload {
  fields: AutofillField[];
  highlight: boolean;
  disclosure: boolean;
}

export interface JobSmithContentApi {
  fill(payload: FillPayload): FillResult;
  collect(fields: AutofillField[]): CollectedField[];
  applyMap(payload: { map: Record<string, string>; highlight: boolean }): number;
  captureJd(): CapturedJd;
  clear(): void;
}

declare global {
  interface Window {
    __jobsmith?: JobSmithContentApi;
  }
}

const api: JobSmithContentApi = {
  fill(payload) {
    const result = fillForm(payload.fields, payload.highlight);
    // Only show the disclosure once, in the top frame.
    if (payload.disclosure && result.report.length > 0 && isTopFrame()) {
      showDisclosure(result.report.length, result.skipped);
    }
    return result;
  },
  collect(fields) {
    return collectUnmatchedFields(fields);
  },
  applyMap({ map, highlight }) {
    return applyValueMap(map, highlight);
  },
  captureJd() {
    return captureJd();
  },
  clear() {
    clearHighlights();
    removeDisclosure();
  },
};

// Install once per frame; re-injection just refreshes the reference.
window.__jobsmith = api;
log.debug("content api ready");

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    return false;
  }
}

/* ------------------------------ JD capture ------------------------------- */

const JD_SELECTORS = [
  '[class*="job-description" i]',
  '[class*="jobdescription" i]',
  '[data-testid*="description" i]',
  '[id*="job-description" i]',
  '[id*="description" i]',
  "article",
  '[role="main"]',
  "main",
  "#content",
];

function captureJd(): CapturedJd {
  const best = pickLargestText(JD_SELECTORS);
  const fallback = (document.body?.innerText ?? "").trim();
  const text = (best.length > 200 ? best : fallback).slice(0, 20_000);
  const jd: CapturedJd = {
    text,
    title: (document.title || firstHeading() || "").trim().slice(0, 200),
    url: location.href,
  };
  const company = guessCompany();
  if (company) jd.company = company;
  return jd;
}

function pickLargestText(selectors: string[]): string {
  let best = "";
  for (const sel of selectors) {
    let nodes: NodeListOf<HTMLElement>;
    try {
      nodes = document.querySelectorAll<HTMLElement>(sel);
    } catch {
      continue;
    }
    for (const node of Array.from(nodes)) {
      const text = (node.innerText ?? "").trim();
      if (text.length > best.length) best = text;
    }
    if (best.length > 1200) break;
  }
  return best;
}

function firstHeading(): string {
  return document.querySelector("h1")?.textContent?.trim() ?? "";
}

function guessCompany(): string | undefined {
  const meta = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
  if (meta) return meta.trim().slice(0, 80);
  const el = document.querySelector<HTMLElement>('[class*="company" i], [data-testid*="company" i]');
  const text = el?.innerText?.trim();
  return text ? text.slice(0, 80) : undefined;
}

/* ----------------------------- disclosure UI ----------------------------- */

const DISCLOSURE_ID = "jobsmith-disclosure";

function showDisclosure(filled: number, skipped: number): void {
  removeDisclosure();
  const banner = document.createElement("div");
  banner.id = DISCLOSURE_ID;
  banner.className = "jobsmith-disclosure";
  Object.assign(banner.style, {
    position: "fixed",
    zIndex: "2147483647",
    bottom: "16px",
    right: "16px",
    maxWidth: "320px",
    background: "#111827",
    color: "#fff",
    padding: "12px 14px",
    borderRadius: "10px",
    font: "13px/1.4 system-ui, sans-serif",
    boxShadow: "0 6px 24px rgba(0,0,0,.35)",
  } as Partial<CSSStyleDeclaration>);

  const skippedNote = skipped > 0 ? ` ${skipped} field(s) already had values and were left as-is.` : "";
  banner.innerHTML =
    `<strong>JobSmith</strong> filled ${filled} field(s).` +
    `${skippedNote} <em>Nothing was submitted — please review before you apply.</em>`;

  const close = document.createElement("button");
  close.textContent = "Dismiss";
  Object.assign(close.style, {
    display: "block",
    marginTop: "8px",
    background: "#2563eb",
    color: "#fff",
    border: "0",
    borderRadius: "6px",
    padding: "4px 10px",
    cursor: "pointer",
    font: "12px system-ui, sans-serif",
  } as Partial<CSSStyleDeclaration>);
  close.addEventListener("click", () => {
    clearHighlights();
    removeDisclosure();
  });
  banner.appendChild(close);

  document.body.appendChild(banner);
  window.setTimeout(removeDisclosure, 12_000);
}

function removeDisclosure(): void {
  document.getElementById(DISCLOSURE_ID)?.remove();
}
