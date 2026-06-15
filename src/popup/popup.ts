/**
 * Popup: quick actions for the current page (autofill / smart-fill / tailor /
 * track) and a compact list of matched jobs.
 *
 * Page interactions run through chrome.scripting.executeScript against ALL frames
 * (so iframe-embedded ATS forms like Greenhouse work) and results are aggregated
 * here. The content script exposes window.__jobsmith in each frame.
 */
import { byId, clear, flash, h } from "../ui/dom.js";
import { getJobsCache, getSettings } from "../lib/storage.js";
import { sendToBackground, sendToOffscreen, type FieldForLlm } from "../lib/messaging.js";
import type { CapturedJd } from "../lib/messaging.js";
import { resolveAutofillFields } from "../autofill/profile.js";
import { trackJob } from "../tracker/store.js";
import { formatRelativeTime, truncate } from "../lib/util.js";
import type { AutofillField, Job, Settings } from "../types/index.js";
import type { CollectedField, FillResult } from "../autofill/filler.js";
import type { FillPayload } from "../content/autofill-content.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("popup");
let settings: Settings;

/* ---- functions injected into the page (must be self-contained) ---- */

const FILL_FN = (payload: FillPayload): FillResult | null =>
  window.__jobsmith ? window.__jobsmith.fill(payload) : null;
const COLLECT_FN = (fields: AutofillField[]): CollectedField[] =>
  window.__jobsmith ? window.__jobsmith.collect(fields) : [];
const APPLY_FN = (payload: { map: Record<string, string>; highlight: boolean }): number =>
  window.__jobsmith ? window.__jobsmith.applyMap(payload) : 0;
const CAPTURE_FN = (): CapturedJd | null =>
  window.__jobsmith ? window.__jobsmith.captureJd() : null;
const CLEAR_FN = (): void => {
  window.__jobsmith?.clear();
};

/* -------------------------------- bootstrap ------------------------------ */

async function init(): Promise<void> {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  settings = await getSettings();
  applyKillState();
  wireButtons();
  await Promise.all([renderJobs(), renderStatus()]);
}

function applyKillState(): void {
  const killed = settings.safety.masterKillSwitch;
  byId("kill-indicator").classList.toggle("hidden", !killed);
  for (const id of ["act-autofill", "act-smartfill", "act-capture", "act-track", "act-clear"]) {
    (byId(id) as HTMLButtonElement).disabled = killed;
  }
}

function wireButtons(): void {
  byId("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  byId("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  byId("open-tracker").addEventListener("click", () => openOptions("applications"));
  byId("act-autofill").addEventListener("click", () => void doAutofill());
  byId("act-smartfill").addEventListener("click", () => void doSmartFill());
  byId("act-capture").addEventListener("click", () => void doCaptureTailor());
  byId("act-track").addEventListener("click", () => void doTrackPage());
  byId("act-clear").addEventListener("click", () => void doClear());
  byId("poll-now").addEventListener("click", () => void doPoll());
}

/* ----------------------------- tab scripting ----------------------------- */

interface FrameResult<T> {
  frameId: number;
  result: T | undefined;
}

async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function isRestricted(url: string | undefined): boolean {
  if (!url) return true;
  return /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url);
}

async function ensureContent(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] });
    await chrome.scripting
      .insertCSS({ target: { tabId, allFrames: true }, files: ["overlay.css"] })
      .catch(() => {});
    return true;
  } catch (e) {
    log.warn("inject failed", e);
    return false;
  }
}

async function execAllFrames<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
): Promise<FrameResult<R>[]> {
  const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func, args });
  return res.map((r) => ({ frameId: r.frameId ?? 0, result: r.result as R | undefined }));
}

async function execFrame<A extends unknown[], R>(
  tabId: number,
  frameId: number,
  func: (...args: A) => R,
  args: A,
): Promise<R | undefined> {
  const res = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
  return res[0]?.result as R | undefined;
}

/* ------------------------------ page actions ----------------------------- */

interface Gate {
  tab: chrome.tabs.Tab;
  status: HTMLElement;
}

async function gateAutofill(): Promise<Gate | null> {
  const status = byId("page-status");
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    flash(status, "Can't act on this page.", "err");
    return null;
  }
  if (!settings.autofill.enabled) {
    flash(status, "Autofill is turned off in Settings.", "err");
    return null;
  }
  if (settings.autofill.perSiteDisabled.includes(hostOf(tab.url))) {
    flash(status, "Autofill is disabled for this site.", "err");
    return null;
  }
  if (!(await ensureContent(tab.id))) {
    flash(status, "Couldn't access this page.", "err");
    return null;
  }
  return { tab, status };
}

async function doAutofill(): Promise<void> {
  const gate = await gateAutofill();
  if (!gate) return;
  const fields = resolveAutofillFields(settings);
  const results = await execAllFrames(gate.tab.id!, FILL_FN, [
    { fields, highlight: settings.autofill.highlightFilled, disclosure: settings.safety.automationDisclosure },
  ]);
  const filled = sumReports(results);
  flash(
    gate.status,
    filled > 0 ? `Filled ${filled} field(s). Review before submitting.` : "No matching empty fields found.",
    filled > 0 ? "ok" : "err",
  );
}

async function doSmartFill(): Promise<void> {
  const gate = await gateAutofill();
  if (!gate) return;
  const fields = resolveAutofillFields(settings);

  // 1) deterministic fill first.
  const fillResults = await execAllFrames(gate.tab.id!, FILL_FN, [
    { fields, highlight: settings.autofill.highlightFilled, disclosure: false },
  ]);
  const deterministic = sumReports(fillResults);

  // 2) collect fields the matcher couldn't map, per frame.
  const collected = await execAllFrames(gate.tab.id!, COLLECT_FN, [fields]);
  const llmFields: FieldForLlm[] = [];
  for (const frame of collected) {
    for (const cf of frame.result ?? []) {
      llmFields.push({
        ref: `${frame.frameId}:${cf.ref}`,
        label: cf.label,
        type: cf.type,
        ...(cf.options ? { options: cf.options } : {}),
      });
    }
  }

  if (llmFields.length === 0) {
    flash(gate.status, `Filled ${deterministic} field(s). Nothing left for the AI.`, "ok");
    return;
  }

  flash(gate.status, `Filled ${deterministic}. Asking on-device AI about ${llmFields.length} more…`, "ok");

  // 3) run the on-device model in the offscreen document.
  await ensureOffscreen();
  const resp = await sendToOffscreen({ target: "offscreen", type: "MAP_FIELDS", fields: llmFields });
  if (resp.engine === "none") {
    flash(
      gate.status,
      `Filled ${deterministic} field(s). AI mapping unavailable${resp.note ? ` (${resp.note})` : ""}.`,
      "err",
    );
    return;
  }

  // 4) group by frame and apply.
  const byFrame = new Map<number, Record<string, string>>();
  for (const [globalRef, value] of Object.entries(resp.map)) {
    const idx = globalRef.indexOf(":");
    if (idx < 0) continue;
    const frameId = Number(globalRef.slice(0, idx));
    const localRef = globalRef.slice(idx + 1);
    const m = byFrame.get(frameId) ?? {};
    m[localRef] = value;
    byFrame.set(frameId, m);
  }

  let aiFilled = 0;
  for (const [frameId, map] of byFrame) {
    const n = await execFrame(gate.tab.id!, frameId, APPLY_FN, [
      { map, highlight: settings.autofill.highlightFilled },
    ]);
    aiFilled += n ?? 0;
  }

  flash(
    gate.status,
    `Filled ${deterministic} known + ${aiFilled} AI-mapped field(s). Review before submitting.`,
    "ok",
  );
}

async function ensureOffscreen(): Promise<void> {
  try {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Run the on-device LLM to map application form fields to your resume locally.",
    });
  } catch (e) {
    log.debug("offscreen ensure", e); // likely already exists
  }
}

async function doCaptureTailor(): Promise<void> {
  const status = byId("page-status");
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    flash(status, "Can't read this page.", "err");
    return;
  }
  if (!(await ensureContent(tab.id))) {
    flash(status, "Couldn't access this page.", "err");
    return;
  }
  const jd = bestJd(await execAllFrames(tab.id, CAPTURE_FN, []));
  if (!jd) {
    flash(status, "Couldn't capture the job description.", "err");
    return;
  }
  await chrome.storage.session.set({
    pendingTailor: { jd: jd.text, title: jd.title, company: jd.company ?? "", url: jd.url },
  });
  await openOptions("studio");
}

async function doTrackPage(): Promise<void> {
  const status = byId("page-status");
  const tab = await getActiveTab();
  if (!tab) return;
  let title = tab.title ?? "Saved role";
  let company = "";
  if (tab.id && !isRestricted(tab.url) && (await ensureContent(tab.id))) {
    const jd = bestJd(await execAllFrames(tab.id, CAPTURE_FN, []));
    if (jd) {
      title = jd.title || title;
      company = jd.company ?? "";
    }
  }
  await trackJob({
    id: `page_${hostOf(tab.url)}_${Date.now()}`,
    title,
    company,
    url: tab.url ?? "",
    descriptionText: "",
  });
  flash(status, "Saved to Applications.", "ok");
}

async function doClear(): Promise<void> {
  const tab = await getActiveTab();
  if (tab?.id && !isRestricted(tab.url) && (await ensureContent(tab.id))) {
    await execAllFrames(tab.id, CLEAR_FN, []);
  }
  flash(byId("page-status"), "Highlights cleared.", "ok");
}

function sumReports(results: FrameResult<FillResult | null>[]): number {
  return results.reduce((acc, r) => acc + (r.result?.report.length ?? 0), 0);
}

function bestJd(results: FrameResult<CapturedJd | null>[]): CapturedJd | null {
  let best: CapturedJd | null = null;
  for (const r of results) {
    const jd = r.result;
    if (jd && (!best || jd.text.length > best.text.length)) best = jd;
  }
  return best;
}

/* --------------------------------- jobs ---------------------------------- */

async function doPoll(): Promise<void> {
  const ps = byId("poll-status");
  ps.textContent = "Refreshing…";
  const resp = await sendToBackground({ type: "POLL_NOW" });
  if (resp.type === "POLL_RESULT") {
    ps.textContent = resp.ok
      ? `${resp.total} matches (${resp.newCount} new).`
      : `Couldn't refresh: ${resp.error ?? "unknown"}`;
    await renderJobs();
  } else if (resp.type === "ERROR") {
    ps.textContent = resp.error;
  }
}

async function renderStatus(): Promise<void> {
  const resp = await sendToBackground({ type: "GET_STATUS" });
  const ps = byId("poll-status");
  if (resp.type === "STATUS") {
    ps.textContent = resp.lastPollAt
      ? `${resp.jobsCount} matches · updated ${formatRelativeTime(resp.lastPollAt)}`
      : "Not polled yet — press Refresh.";
  }
}

async function renderJobs(): Promise<void> {
  const list = byId("job-list");
  const jobs = await getJobsCache();
  clear(list);
  if (jobs.length === 0) {
    list.appendChild(h("div", { class: "empty", text: "No matched jobs yet." }));
    return;
  }
  for (const job of jobs.slice(0, 40)) list.appendChild(jobCard(job));
}

function jobCard(job: Job): HTMLElement {
  const chips: HTMLElement[] = [];
  if (job.salary) chips.push(h("span", { class: "chip", text: job.salary }));
  for (const tag of job.tags.slice(0, 4)) chips.push(h("span", { class: "chip", text: tag }));

  const posted = job.postedAt ? ` · ${formatRelativeTime(job.postedAt)}` : "";
  return h(
    "div",
    { class: "job" },
    h("div", { class: "title", text: truncate(job.title, 70) }),
    h("div", {
      class: "meta",
      text: `${job.company}${job.location ? ` · ${job.location}` : ""} · ${job.sourceLabel}${posted}`,
    }),
    chips.length ? h("div", { class: "chips" }, ...chips) : null,
    h(
      "div",
      { class: "actions" },
      h("button", { class: "link-btn", text: "Open", onclick: () => openUrl(job.url) }),
      h("button", { class: "link-btn", text: "Tailor", onclick: () => tailorForJob(job) }),
      h("button", { class: "link-btn", text: "Track", onclick: () => trackOne(job) }),
    ),
    job.attribution ? h("div", { class: "attribution", text: job.attribution }) : null,
  );
}

function openUrl(url: string): void {
  if (url) chrome.tabs.create({ url });
}

async function tailorForJob(job: Job): Promise<void> {
  await chrome.storage.session.set({
    pendingTailor: {
      jd: job.descriptionText || job.description,
      title: job.title,
      company: job.company,
      url: job.url,
    },
  });
  await openOptions("studio");
}

async function trackOne(job: Job): Promise<void> {
  await trackJob(job);
  flash(byId("poll-status"), `Tracking "${truncate(job.title, 30)}".`, "ok");
}

/* -------------------------------- helpers -------------------------------- */

async function openOptions(section: string): Promise<void> {
  await chrome.storage.session.set({ pendingSection: section });
  chrome.runtime.openOptionsPage();
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => log.error("popup init failed", e));
});
