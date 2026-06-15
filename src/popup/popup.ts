/**
 * Popup: quick actions for the current page (autofill / tailor / track) and a
 * compact list of the most recent matched jobs. Heavy work (settings, tailoring)
 * lives in the options page; the popup links there.
 */
import { byId, clear, h } from "../ui/dom.js";
import { flash } from "../ui/dom.js";
import { getJobsCache, getSettings } from "../lib/storage.js";
import { sendToBackground, sendToTab } from "../lib/messaging.js";
import { trackJob } from "../tracker/store.js";
import { formatRelativeTime, truncate } from "../lib/util.js";
import type { Job, Settings } from "../types/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("popup");
let settings: Settings;

async function init(): Promise<void> {
  // Clear the "new jobs" badge once the user opens the popup.
  chrome.action.setBadgeText({ text: "" }).catch(() => {});

  settings = await getSettings();
  applyKillState();
  wireButtons();
  await Promise.all([renderJobs(), renderStatus()]);
}

function applyKillState(): void {
  const killed = settings.safety.masterKillSwitch;
  byId("kill-indicator").classList.toggle("hidden", !killed);
  for (const id of ["act-autofill", "act-capture", "act-track", "act-clear"]) {
    (byId(id) as HTMLButtonElement).disabled = killed;
  }
}

function wireButtons(): void {
  byId("open-options").addEventListener("click", () => chrome.runtime.openOptionsPage());
  byId("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  byId("open-tracker").addEventListener("click", () => openOptions("applications"));
  byId("act-autofill").addEventListener("click", () => void doAutofill());
  byId("act-capture").addEventListener("click", () => void doCaptureTailor());
  byId("act-track").addEventListener("click", () => void doTrackPage());
  byId("act-clear").addEventListener("click", () => void doClear());
  byId("poll-now").addEventListener("click", () => void doPoll());
}

/* ------------------------------ page actions ----------------------------- */

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
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["overlay.css"] }).catch(() => {});
    return true;
  } catch (e) {
    log.warn("inject failed", e);
    return false;
  }
}

async function doAutofill(): Promise<void> {
  const status = byId("page-status");
  const tab = await getActiveTab();
  if (!tab?.id || isRestricted(tab.url)) {
    flash(status, "Can't autofill on this page.", "err");
    return;
  }
  if (!settings.autofill.enabled) {
    flash(status, "Autofill is turned off in Settings.", "err");
    return;
  }
  if (settings.autofill.perSiteDisabled.includes(hostOf(tab.url))) {
    flash(status, "Autofill is disabled for this site.", "err");
    return;
  }
  if (!(await ensureContent(tab.id))) {
    flash(status, "Couldn't access this page.", "err");
    return;
  }
  const resp = await sendToTab(tab.id, {
    type: "AUTOFILL",
    fields: settings.autofill.fields,
    options: {
      highlight: settings.autofill.highlightFilled,
      disclosure: settings.safety.automationDisclosure,
    },
  });
  if (resp.type === "AUTOFILL_RESULT") {
    flash(
      status,
      resp.report.length
        ? `Filled ${resp.report.length} field(s). Review before submitting.`
        : "No matching empty fields found.",
      resp.report.length ? "ok" : "err",
    );
  } else if (resp.type === "ERROR") {
    flash(status, resp.error, "err");
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
  const resp = await sendToTab(tab.id, { type: "CAPTURE_JD" });
  if (resp.type !== "JD") {
    flash(status, "Couldn't capture the job description.", "err");
    return;
  }
  await chrome.storage.session.set({
    pendingTailor: {
      jd: resp.jd.text,
      title: resp.jd.title,
      company: resp.jd.company ?? "",
      url: resp.jd.url,
    },
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
    const resp = await sendToTab(tab.id, { type: "CAPTURE_JD" });
    if (resp.type === "JD") {
      title = resp.jd.title || title;
      company = resp.jd.company ?? "";
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
  if (tab?.id && !isRestricted(tab.url)) {
    if (await ensureContent(tab.id)) await sendToTab(tab.id, { type: "CLEAR_HIGHLIGHTS" });
  }
  flash(byId("page-status"), "Highlights cleared.", "ok");
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
