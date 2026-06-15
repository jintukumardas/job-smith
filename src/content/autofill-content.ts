/**
 * Content script — injected ON DEMAND (never statically) when you click an
 * action in the popup. It fills the current form, captures a job description,
 * or clears highlights. It shows a visible disclosure that automation ran and
 * NEVER submits anything.
 */
import { onTabMessage, type TabResponse, type CapturedJd } from "../lib/messaging.js";
import { fillForm, clearHighlights } from "../autofill/filler.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("content");

declare global {
  interface Window {
    __jobsmithInjected?: boolean;
  }
}

// Guard against duplicate listeners when injected more than once.
if (!window.__jobsmithInjected) {
  window.__jobsmithInjected = true;

  onTabMessage(async (req): Promise<TabResponse> => {
    try {
      switch (req.type) {
        case "PING":
          return { type: "PONG" };

        case "AUTOFILL": {
          const { report, skipped } = fillForm(req.fields, req.options.highlight);
          if (req.options.disclosure && report.length > 0) showDisclosure(report.length, skipped);
          log.info(`autofilled ${report.length} field(s), skipped ${skipped}`);
          return { type: "AUTOFILL_RESULT", report, skipped };
        }

        case "CAPTURE_JD":
          return { type: "JD", jd: captureJd() };

        case "CLEAR_HIGHLIGHTS":
          clearHighlights();
          removeDisclosure();
          return { type: "OK" };

        default:
          return { type: "ERROR", error: "unknown request" };
      }
    } catch (e) {
      log.error("content handler failed", e);
      return { type: "ERROR", error: e instanceof Error ? e.message : String(e) };
    }
  });

  log.debug("content script ready");
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
  const best = picklargestText(JD_SELECTORS);
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

function picklargestText(selectors: string[]): string {
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
    if (best.length > 1200) break; // good enough
  }
  return best;
}

function firstHeading(): string {
  return document.querySelector("h1")?.textContent?.trim() ?? "";
}

function guessCompany(): string | undefined {
  const meta = document
    .querySelector('meta[property="og:site_name"]')
    ?.getAttribute("content");
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
  // Inline fallback styles so the disclosure is visible even if the stylesheet
  // was not injected.
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
