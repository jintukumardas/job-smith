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
import {
  onMapProgress,
  sendToBackground,
  sendToOffscreen,
  type FieldForLlm,
  type JdContext,
} from "../lib/messaging.js";
import type { CapturedJd } from "../lib/messaging.js";
import { resolveAutofillFields } from "../autofill/profile.js";
import { trackJob } from "../tracker/store.js";
import { formatRelativeTime, truncate } from "../lib/util.js";
import type { AutofillField, Job, Settings } from "../types/index.js";
import type { CollectedField, FillResult } from "../autofill/filler.js";
import type { FillPayload } from "../content/autofill-content.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("popup");
let settings: Settings | null = null;

/** Load settings once; handlers call this so they never run against undefined. */
async function ensureSettings(): Promise<Settings> {
  if (!settings) settings = await getSettings();
  return settings;
}

/**
 * Set a status line that STAYS until the next action (errors and progress must
 * not vanish after a few seconds the way a transient toast does).
 */
function setStatus(el: HTMLElement, message: string, kind: "ok" | "err" | "info" = "info"): void {
  el.textContent = message;
  el.className = `flash ${kind}`;
}

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

function init(): void {
  // Wire the buttons FIRST, synchronously, before any await — otherwise a slow or
  // failing getSettings()/render would leave the buttons dead and clicks silent.
  wireButtons();
  void boot();
}

async function boot(): Promise<void> {
  chrome.action.setBadgeText({ text: "" }).catch(() => {});
  try {
    const s = await ensureSettings();
    applyKillState(s);
    await Promise.all([renderJobs(), renderStatus()]);
    readinessHint(s);
  } catch (e) {
    log.error("popup boot failed", e);
    setStatus(byId("page-status"), "JobSmith couldn't load its settings. Reopen the popup, or reload it at chrome://extensions.", "err");
  }
}

function applyKillState(s: Settings): void {
  const killed = s.safety.masterKillSwitch;
  byId("kill-indicator").classList.toggle("hidden", !killed);
  for (const id of ["act-autofill", "act-smartfill", "act-capture", "act-track", "act-clear"]) {
    (byId(id) as HTMLButtonElement).disabled = killed;
  }
}

/** On open, proactively tell the user if the prerequisites for filling are missing. */
function readinessHint(s: Settings): void {
  if (s.safety.masterKillSwitch) {
    setStatus(byId("page-status"), "JobSmith is paused (kill switch on). Turn it off in Settings → Privacy & safety.", "info");
    return;
  }
  if (!hasFillValues(resolveAutofillFields(s))) {
    setStatus(byId("page-status"), "Add your résumé in Settings → Résumé so Autofill and Smart Fill have something to fill.", "info");
  }
}

function wireButtons(): void {
  // Bind each control independently: a single missing element (or a handler that
  // throws) must never leave the rest of the buttons dead.
  const on = (id: string, run: () => void): void => {
    const el = document.getElementById(id);
    if (!el) {
      log.warn(`button #${id} not found — skipping`);
      return;
    }
    el.addEventListener("click", () => {
      try {
        run();
      } catch (e) {
        log.error(`#${id} handler threw`, e);
        setStatus(byId("page-status"), "Something went wrong — check the console (right-click popup → Inspect).", "err");
      }
    });
  };

  on("open-options", () => void chrome.runtime.openOptionsPage());
  on("open-settings", () => void chrome.runtime.openOptionsPage());
  on("open-tracker", () => void openOptions("applications"));
  on("act-autofill", () => void doAutofill());
  on("act-smartfill", () => void doSmartFill());
  on("act-capture", () => void doCaptureTailor());
  on("act-track", () => void doTrackPage());
  on("act-clear", () => void doClear());
  on("poll-now", () => void doPoll());
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
  settings: Settings;
}

async function gateAutofill(): Promise<Gate | null> {
  const status = byId("page-status");
  const s = await ensureSettings();
  if (s.safety.masterKillSwitch) {
    setStatus(status, "JobSmith is paused (kill switch on). Turn it off in Settings → Privacy & safety.", "err");
    return null;
  }
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    setStatus(status, "Can't act on this page — it's a browser/system page (chrome://, the Web Store, etc.). Open a real application page.", "err");
    return null;
  }
  if (!s.autofill.enabled) {
    setStatus(status, "Autofill is turned off. Enable it in Settings → Autofill.", "err");
    return null;
  }
  if (s.autofill.perSiteDisabled.includes(hostOf(tab.url))) {
    setStatus(status, `Autofill is disabled for ${hostOf(tab.url)}. Re-enable it in Settings → Autofill.`, "err");
    return null;
  }
  if (!(await ensureContent(tab.id))) {
    setStatus(status, "Couldn't inject into this page. Reload the page, then try again.", "err");
    return null;
  }
  return { tab, status, settings: s };
}

async function doAutofill(): Promise<void> {
  const gate = await gateAutofill();
  if (!gate) return;
  const { settings: s } = gate;
  const fields = resolveAutofillFields(s);
  if (!hasFillValues(fields)) {
    setStatus(gate.status, "No résumé details yet — add them in Settings → Résumé, then try again.", "err");
    return;
  }
  setStatus(gate.status, "Filling…", "info");
  const results = await execAllFrames(gate.tab.id!, FILL_FN, [
    { fields, highlight: s.autofill.highlightFilled, disclosure: s.safety.automationDisclosure },
  ]);
  const filled = sumReports(results);
  if (filled > 0) {
    setStatus(gate.status, `Filled ${filled} field(s). Review before submitting.`, "ok");
  } else {
    setStatus(gate.status, "No fields I recognise were empty here. Try Smart Fill (AI) — it reads the page and the custom questions.", "err");
  }
}

function hasFillValues(fields: AutofillField[]): boolean {
  return fields.some((f) => f.enabled && f.value.trim().length > 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function doSmartFill(): Promise<void> {
  const gate = await gateAutofill();
  if (!gate) return;
  const { settings: s, tab } = gate;
  const fields = resolveAutofillFields(s);
  if (!hasFillValues(fields)) {
    setStatus(gate.status, "No résumé details yet — add them in Settings → Résumé. The AI fills from your résumé.", "err");
    return;
  }
  if (!s.llm.enabled) {
    setStatus(gate.status, "On-device AI is off. Turn it on in Settings → Résumé studio.", "err");
    return;
  }

  setStatus(gate.status, "Reading the page…", "info");

  // 1) deterministic fill first (instant, fills the fields we recognise).
  const fillResults = await execAllFrames(tab.id!, FILL_FN, [
    { fields, highlight: s.autofill.highlightFilled, disclosure: false },
  ]);
  const deterministic = sumReports(fillResults);

  // 2) capture the role overview so the model can tailor open-ended answers.
  const jd = toJdContext(bestJd(await execAllFrames(tab.id!, CAPTURE_FN, [])));

  // 3) collect fields the matcher couldn't map, per frame.
  const collected = await execAllFrames(tab.id!, COLLECT_FN, [fields]);
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
    setStatus(gate.status, `Filled ${deterministic} field(s). Nothing was left for the AI.`, "ok");
    return;
  }

  setStatus(gate.status, `Filled ${deterministic}. Starting on-device AI for ${llmFields.length} more…`, "info");

  // 4) run the on-device model in the offscreen document (survives nothing if the
  //    popup closes, so tell the user to keep it open during the one-time download).
  const offErr = await ensureOffscreen();
  if (offErr) {
    setStatus(gate.status, `Filled ${deterministic}. AI unavailable: ${offErr}`, "err");
    return;
  }

  // Live progress so a multi-GB first-run download never looks frozen.
  const stopProgress = onMapProgress((p) => {
    if (p.phase === "loading-model") {
      const pct = typeof p.progress === "number" ? ` ${Math.round(p.progress * 100)}%` : "";
      setStatus(gate.status, `Downloading on-device AI model${pct} — first run only, keep this popup open…`, "info");
    } else {
      // Per-field progress, e.g. "Answering 2 of 4: Why are you interested…".
      setStatus(gate.status, p.message || `Filling ${llmFields.length} field(s) with on-device AI…`, "info");
    }
  });

  try {
    const req = {
      target: "offscreen" as const,
      type: "MAP_FIELDS" as const,
      fields: llmFields,
      resume: s.resume,
      model: s.llm.model,
      temperature: s.llm.temperature,
      ...(jd ? { jd } : {}),
    };
    let resp = await sendToOffscreen(req);
    // The offscreen listener may not be ready on the very first creation; retry once.
    if (resp.error && /establish connection|receiving end|port closed/i.test(resp.error)) {
      await delay(500);
      resp = await sendToOffscreen(req);
    }
    if (resp.engine === "none") {
      const why = resp.error || resp.note || "unknown";
      log.warn(`smart fill: AI unavailable — ${why}`);
      const hint = /webgpu/i.test(why)
        ? "Smart Fill needs WebGPU (Chrome 120+ on a supported GPU). Autofill form still works for standard fields."
        : `AI mapping unavailable (${why}).`;
      setStatus(gate.status, `Filled ${deterministic} field(s). ${hint}`, "err");
      return;
    }

    // 5) group the ref->value map by frame and apply it back into the page.
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
      const n = await execFrame(tab.id!, frameId, APPLY_FN, [
        { map, highlight: s.autofill.highlightFilled },
      ]);
      aiFilled += n ?? 0;
    }

    setStatus(
      gate.status,
      `Filled ${deterministic} known + ${aiFilled} AI field(s). Review everything before you submit.`,
      "ok",
    );
  } finally {
    stopProgress();
  }
}

/** Turn a captured JD into the trimmed context we send to the model (or null). */
function toJdContext(jd: CapturedJd | null): JdContext | null {
  if (!jd) return null;
  const text = jd.text.trim();
  if (text.length < 80 && !jd.title) return null; // nothing useful to tailor from
  const ctx: JdContext = { text };
  if (jd.title) ctx.title = jd.title;
  if (jd.company) ctx.company = jd.company;
  return ctx;
}

/** Ensure the offscreen document exists. Returns null on success, else a reason. */
async function ensureOffscreen(): Promise<string | null> {
  try {
    if (!chrome.offscreen || typeof chrome.offscreen.createDocument !== "function") {
      return "offscreen API unavailable — reload the extension at chrome://extensions";
    }
    if (await chrome.offscreen.hasDocument()) return null;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS" as chrome.offscreen.Reason],
      justification: "Run the on-device LLM to map application form fields to your resume locally.",
    });
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/single offscreen|already/i.test(msg)) return null; // created concurrently
    log.warn("offscreen create failed", msg);
    return msg;
  }
}

async function doCaptureTailor(): Promise<void> {
  const status = byId("page-status");
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    setStatus(status, "Can't read this page — open a real job posting first.", "err");
    return;
  }
  setStatus(status, "Reading the job description…", "info");
  if (!(await ensureContent(tab.id))) {
    setStatus(status, "Couldn't inject into this page. Reload it and try again.", "err");
    return;
  }
  const jd = bestJd(await execAllFrames(tab.id, CAPTURE_FN, []));
  if (!jd) {
    setStatus(status, "Couldn't find a job description on this page. Open the posting, or paste it in Résumé Studio.", "err");
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

function start(): void {
  try {
    init();
  } catch (e) {
    log.error("popup init failed", e);
  }
}

// Run now if the DOM is already parsed (the script is at the end of <body>, so it
// usually is), otherwise wait for it. Either way the buttons get wired.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}
