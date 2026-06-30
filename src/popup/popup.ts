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
  type FieldForLlm,
  type JdContext,
} from "../lib/messaging.js";
import type { CapturedJd } from "../lib/messaging.js";
import { resolveAutofillFields } from "../autofill/profile.js";
import { isResumeMatchable, matchResumeToJd, type JobMatch } from "../resume/job-match.js";
import { trackJob } from "../tracker/store.js";
import { formatRelativeTime, truncate } from "../lib/util.js";
import type { AutofillField, Job, ScrapedJob, Settings } from "../types/index.js";
import type { CollectedField, FillResult } from "../autofill/filler.js";
import type { FillPayload } from "../content/autofill-content.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("popup");
let settings: Settings | null = null;

/** How many relevance-ranked listings to re-score against the résumé (we show 40). */
const RANK_WINDOW = 60;
/** Max cards rendered after filtering. */
const MAX_CARDS = 40;

/** The ranked listings from the last render, kept so filters re-render without re-scoring. */
let rankedJobs: { job: Job; match: JobMatch | null }[] = [];

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
const CAPTURE_FN = (): CapturedJd | null =>
  window.__jobsmith ? window.__jobsmith.captureJd() : null;
const SCAN_FN = (): ScrapedJob[] =>
  window.__jobsmith ? window.__jobsmith.scanJobs() : [];
const DETECT_FN = (): string[] =>
  window.__jobsmith ? window.__jobsmith.detectAts() : [];
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
  for (const id of ["act-autofill", "act-smartfill", "act-capture", "act-track", "act-scan", "act-detect", "act-clear"]) {
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
  on("act-scan", () => void doScanPage());
  on("act-detect", () => void doDetectAdd());
  on("act-clear", () => void doClear());
  on("poll-now", () => void doPoll());

  const search = document.getElementById("job-search");
  if (search) search.addEventListener("input", applyJobFilters);
  const source = document.getElementById("job-source");
  if (source) source.addEventListener("change", applyJobFilters);
  const age = document.getElementById("job-age");
  if (age) age.addEventListener("change", applyJobFilters);
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

  // 4) hand the slow on-device step to the service worker. It runs the model in
  //    the offscreen document and applies each answer to the page as it's
  //    produced — so answers land one by one AND the job keeps going even if the
  //    user closes this popup. While open, we mirror its live progress.
  const stopProgress = onMapProgress((p) => {
    if (p.phase === "loading-model") {
      const pct = typeof p.progress === "number" ? ` ${Math.round(p.progress * 100)}%` : "";
      setStatus(gate.status, `Downloading on-device AI model${pct} — first run only…`, "info");
    } else {
      // Per-field / per-fill progress streamed from the background.
      setStatus(
        gate.status,
        p.message || `Filling ${llmFields.length} field(s) with on-device AI…`,
        p.done ? "ok" : "info",
      );
    }
    if (p.done) stopProgress();
  });

  const resp = await sendToBackground({
    type: "SMART_FILL",
    tabId: tab.id!,
    fields: llmFields,
    highlight: s.autofill.highlightFilled,
    ...(jd ? { jd } : {}),
  });
  if (resp.type === "ERROR") {
    stopProgress();
    const hint = /webgpu/i.test(resp.error)
      ? "Smart Fill needs WebGPU (Chrome 120+ on a supported GPU). Autofill still works for standard fields."
      : resp.error;
    setStatus(gate.status, `Filled ${deterministic} field(s). ${hint}`, "err");
    return;
  }
  setStatus(
    gate.status,
    `Filled ${deterministic} known. AI is filling ${llmFields.length} more — answers appear as they're written. You can close this popup.`,
    "info",
  );
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

/** Read job listings from the page the user is viewing and add them to the list. */
async function doScanPage(): Promise<void> {
  const status = byId("page-status");
  const s = await ensureSettings();
  if (s.safety.masterKillSwitch) {
    setStatus(status, "JobSmith is paused (kill switch on). Turn it off in Settings → Privacy & safety.", "err");
    return;
  }
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    setStatus(status, "Can't scan this page — open a job board or a company careers page first.", "err");
    return;
  }
  setStatus(status, "Scanning this page for jobs…", "info");
  if (!(await ensureContent(tab.id))) {
    setStatus(status, "Couldn't read this page. Reload it and try again.", "err");
    return;
  }

  // Merge results from every frame, de-duped by URL.
  const frames = await execAllFrames(tab.id, SCAN_FN, []);
  const byUrl = new Map<string, ScrapedJob>();
  for (const frame of frames) {
    for (const job of frame.result ?? []) {
      if (job.url && !byUrl.has(job.url)) byUrl.set(job.url, job);
    }
  }
  const jobs = [...byUrl.values()];
  if (jobs.length === 0) {
    setStatus(status, "No job listings found on this page. Open a search results page or a careers listing.", "err");
    return;
  }

  const resp = await sendToBackground({
    type: "ADD_SCANNED_JOBS",
    jobs,
    sourceLabel: hostOf(tab.url) || "Scanned page",
  });
  if (resp.type === "SCAN_RESULT") {
    setStatus(
      status,
      `Found ${resp.total} listing(s) — added ${resp.added} new to your list below.`,
      "ok",
    );
    await renderJobs();
  } else if (resp.type === "ERROR") {
    setStatus(status, resp.error, "err");
  }
}

/** Detect the ATS behind the current career page and add it as a tracked source. */
async function doDetectAdd(): Promise<void> {
  const status = byId("page-status");
  const s = await ensureSettings();
  if (s.safety.masterKillSwitch) {
    setStatus(status, "JobSmith is paused (kill switch on). Turn it off in Settings → Privacy & safety.", "err");
    return;
  }
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    setStatus(status, "Open a company careers page first, then Detect & add.", "err");
    return;
  }
  setStatus(status, "Detecting the job source on this page…", "info");
  if (!(await ensureContent(tab.id))) {
    setStatus(status, "Couldn't read this page. Reload it and try again.", "err");
    return;
  }

  const frames = await execAllFrames(tab.id, DETECT_FN, []);
  const candidates = new Set<string>();
  for (const frame of frames) for (const url of frame.result ?? []) candidates.add(url);

  const resp = await sendToBackground({
    type: "DETECT_AND_ADD",
    pageUrl: tab.url ?? "",
    candidates: [...candidates],
    label: hostOf(tab.url),
  });
  if (resp.type === "DETECT_RESULT") {
    if (resp.added) {
      setStatus(
        status,
        `Tracking ${resp.detected} — added ${resp.count} jobs. It'll refresh automatically from now on.`,
        "ok",
      );
      await renderJobs();
    } else {
      setStatus(status, resp.error ?? "Couldn't detect a job source. Try “Scan this page” instead.", "err");
    }
  } else if (resp.type === "ERROR") {
    setStatus(status, resp.error, "err");
  }
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
  const [s, jobs] = await Promise.all([ensureSettings(), getJobsCache()]);
  if (jobs.length === 0) {
    rankedJobs = [];
    populateSourceFilter([]);
    clear(list);
    list.appendChild(h("div", { class: "empty", text: "No matched jobs yet." }));
    return;
  }

  // Score the relevance-ranked candidates against the résumé (pure + on-device)
  // and lead with the best fit. We only re-rank the top window the cache already
  // surfaced — enough to find the strong matches without scoring all 200. Without
  // a résumé we can't score, so the existing relevance order stands.
  const matchable = isResumeMatchable(s.resume);
  const ranked = jobs.slice(0, RANK_WINDOW).map((job, idx) => ({
    job,
    idx,
    match: matchable ? matchResumeToJd(s.resume, jobText(job)) : null,
  }));
  if (matchable) {
    // Best résumé match first; ties fall back to the existing relevance order.
    ranked.sort((a, b) => b.match!.score - a.match!.score || a.idx - b.idx);
  }

  rankedJobs = ranked.map(({ job, match }) => ({ job, match }));
  populateSourceFilter(rankedJobs.map((r) => r.job));
  applyJobFilters();
}

/** Fill the source dropdown with the distinct sources present in the cache. */
function populateSourceFilter(jobs: Job[]): void {
  const sel = document.getElementById("job-source") as HTMLSelectElement | null;
  if (!sel) return;
  const prev = sel.value;
  const labels = Array.from(new Set(jobs.map((j) => j.sourceLabel).filter(Boolean))).sort();
  clear(sel);
  sel.appendChild(h("option", { value: "", text: "All sources" }));
  for (const label of labels) sel.appendChild(h("option", { value: label, text: label }));
  // Preserve the prior selection if it still exists.
  sel.value = labels.includes(prev) ? prev : "";
}

/** Render the ranked list filtered by the search box + source dropdown. */
function applyJobFilters(): void {
  const list = byId("job-list");
  const query = (document.getElementById("job-search") as HTMLInputElement | null)?.value
    .trim()
    .toLowerCase() ?? "";
  const source = (document.getElementById("job-source") as HTMLSelectElement | null)?.value ?? "";
  const ageDays = Number((document.getElementById("job-age") as HTMLSelectElement | null)?.value) || 0;
  const cutoff = ageDays > 0 ? Date.now() - ageDays * 86_400_000 : 0;

  const filtered = rankedJobs.filter(({ job }) => {
    if (source && job.sourceLabel !== source) return false;
    if (query && !jobMatchesQuery(job, query)) return false;
    // Posting-age filter: drop listings with a known date older than the window.
    // Listings with no known date are kept (we can't judge their age).
    if (cutoff && typeof job.postedAt === "number" && job.postedAt < cutoff) return false;
    return true;
  });

  clear(list);
  if (filtered.length === 0) {
    const msg = rankedJobs.length === 0 ? "No matched jobs yet." : "No jobs match your filters.";
    list.appendChild(h("div", { class: "empty", text: msg }));
    return;
  }
  for (const { job, match } of filtered.slice(0, MAX_CARDS)) list.appendChild(jobCard(job, match));
}

function jobMatchesQuery(job: Job, query: string): boolean {
  const hay = `${job.title} ${job.company} ${job.location} ${job.tags.join(" ")}`.toLowerCase();
  return hay.includes(query);
}

/** Title + JD text used to score a listing against the résumé. */
function jobText(job: Job): string {
  return `${job.title}\n${job.descriptionText || job.description || ""}`;
}

function jobCard(job: Job, match: JobMatch | null): HTMLElement {
  const chips: HTMLElement[] = [];
  if (job.salary) chips.push(h("span", { class: "chip", text: job.salary }));
  for (const tag of job.tags.slice(0, 4)) chips.push(h("span", { class: "chip", text: tag }));

  const posted = job.postedAt ? ` · ${formatRelativeTime(job.postedAt)}` : "";
  return h(
    "div",
    { class: "job" },
    h(
      "div",
      { class: "job-head" },
      h("div", { class: "title", text: truncate(job.title, 60) }),
      match ? matchBadge(match) : null,
    ),
    h("div", {
      class: "meta",
      text: `${job.company}${job.location ? ` · ${job.location}` : ""} · ${job.sourceLabel}${posted}`,
    }),
    chips.length ? h("div", { class: "chips" }, ...chips) : null,
    match && match.missing.length
      ? h("div", { class: "match-gaps small muted", text: `Gaps: ${match.missing.slice(0, 6).join(", ")}` })
      : null,
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

/** A coloured "NN% match" pill; hover reveals which skills matched / are missing. */
function matchBadge(match: JobMatch): HTMLElement {
  const tier = match.score >= 70 ? "high" : match.score >= 40 ? "mid" : "low";
  const lines: string[] = [];
  if (match.matched.length) lines.push(`Matched: ${match.matched.slice(0, 12).join(", ")}`);
  if (match.missing.length) lines.push(`Missing: ${match.missing.slice(0, 12).join(", ")}`);
  return h("span", {
    class: `match ${tier}`,
    title: lines.join("\n") || "No overlapping skills detected — add the JD to Résumé Studio for a tailored pass.",
    text: `${match.score}% match`,
  });
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
