/**
 * JobSmith background service worker (MV3).
 *
 * Responsibilities:
 *  - Schedule + run polite, rate-limited job polling (chrome.alarms).
 *  - Notify about new matches and due follow-ups (respecting the kill switch
 *    and quiet hours).
 *  - Route messages from the popup/options pages.
 *  - Drive the on-device Smart Fill once the popup hands it off, so the job
 *    keeps running and applying answers after the popup closes (user-initiated;
 *    it only fills fields the user asked for and never auto-submits).
 *
 * It never initiates page actions on its own and never auto-submits anything.
 */
import { clamp, uid } from "../lib/util.js";
import { createLogger } from "../lib/logger.js";
import {
  getApplications,
  getJobsCache,
  getProviderState,
  getSeenJobs,
  getSettings,
  getRemindedFollowUps,
  markJobsSeen,
  saveSettings,
  setJobsCache,
  setProviderState,
  setRemindedFollowUps,
} from "../lib/storage.js";
import {
  onBackgroundMessage,
  sendMapProgress,
  sendToOffscreen,
  SMART_FILL_PORT,
  type BgRequest,
  type BgResponse,
  type SmartFillStream,
} from "../lib/messaging.js";
import type { CustomSource, Job, ResumeData, ScrapedJob } from "../types/index.js";
import { createHttp, pollJobs } from "../jobs/aggregator.js";
import { buildJob, type ProviderContext } from "../jobs/provider.js";
import { fetchCustomSource, probeAtsForUrl } from "../jobs/providers/custom.js";
import { canonicalSourceUrl, parseCustomSource } from "../jobs/custom-source.js";
import { dueFollowUps, followUpKey } from "../tracker/store.js";
import {
  notifyFollowUp,
  notifyNewJobs,
  notifyTest,
  registerNotificationClicks,
} from "./notifications.js";

const log = createLogger("sw");

const POLL_ALARM = "jobsmith-poll";
const REMINDER_ALARM = "jobsmith-reminders";
const MIN_POLL_MINUTES = 15;
const MAX_POLL_MINUTES = 1440;
const REMINDER_PERIOD_MINUTES = 60;

const BADGE_COLOR = "#2563eb";

/* ------------------------------- lifecycle ------------------------------- */

chrome.runtime.onInstalled.addListener(async () => {
  try {
    // Persist a fully-formed settings object (fills any new defaults).
    await saveSettings(await getSettings());
    chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    await scheduleAlarms();
    log.info("installed; running first poll");
    // Kick off an initial poll directly. Do NOT reuse POLL_ALARM here — creating
    // an alarm with an existing name replaces it, which would turn the recurring
    // poll alarm scheduleAlarms() just created into a one-shot and kill polling.
    void runPoll(false);
  } catch (e) {
    log.error("onInstalled failed", e);
  }
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleAlarms();
});

registerNotificationClicks();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) void runPoll(false);
  else if (alarm.name === REMINDER_ALARM) void runReminders();
});

/* -------------------------------- messages ------------------------------- */

onBackgroundMessage(async (req): Promise<BgResponse> => {
  switch (req.type) {
    case "POLL_NOW": {
      const r = await runPoll(true);
      return { type: "POLL_RESULT", ...r };
    }
    case "RESCHEDULE": {
      await scheduleAlarms();
      return { type: "OK" };
    }
    case "SYNC_REMINDERS": {
      await runReminders();
      return { type: "OK" };
    }
    case "TEST_NOTIFICATION": {
      notifyTest();
      return { type: "OK" };
    }
    case "SMART_FILL": {
      const err = await startSmartFill(req);
      return err ? { type: "ERROR", error: err } : { type: "OK" };
    }
    case "ADD_SCANNED_JOBS": {
      return addScannedJobs(req.jobs, req.sourceLabel);
    }
    case "RESOLVE_CUSTOM_SOURCE": {
      return resolveCustomSource(req.url, req.label);
    }
    case "DETECT_AND_ADD": {
      return detectAndAdd(req.pageUrl, req.candidates, req.label);
    }
    case "GET_STATUS": {
      const [providerState, cached] = await Promise.all([getProviderState(), getJobsCache()]);
      const lastPollAt = Object.values(providerState).reduce(
        (max, s) => Math.max(max, s.lastFetch ?? 0),
        0,
      );
      return {
        type: "STATUS",
        providerState,
        jobsCount: cached.length,
        lastPollAt: lastPollAt || null,
      };
    }
    default:
      return { type: "ERROR", error: "unknown request" };
  }
});

/* ------------------------------- smart fill ------------------------------ */
// The popup gathers the page fields (it has chrome.scripting) then hands the
// slow on-device step to us. We run the offscreen model, and as each answer
// streams back over SMART_FILL_PORT we apply it to the tab right away — so
// answers land incrementally and the whole job survives the popup closing.

interface SmartFillJob {
  tabId: number;
  highlight: boolean;
  total: number;
  filled: number;
  /** Global refs already written, so the stream and the safety net don't double-count. */
  applied: Set<string>;
}

let activeSmartFill: SmartFillJob | null = null;

// Injected into the page (must be self-contained): write one ref->value map via
// the content API. Mirrors APPLY_FN in the popup.
const APPLY_FN = (payload: { map: Record<string, string>; highlight: boolean }): number =>
  window.__jobsmith ? window.__jobsmith.applyMap(payload) : 0;

/** Apply one answer to its frame; tolerant of a closed/navigated tab or missing content. */
async function applyField(job: SmartFillJob, globalRef: string, value: string): Promise<void> {
  if (job.applied.has(globalRef)) return; // already on the page
  const idx = globalRef.indexOf(":");
  if (idx < 0) return;
  const frameId = Number(globalRef.slice(0, idx));
  const localRef = globalRef.slice(idx + 1);
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: job.tabId, frameIds: [frameId] },
      func: APPLY_FN,
      args: [{ map: { [localRef]: value }, highlight: job.highlight }],
    });
    const n = (res[0]?.result as number | undefined) ?? 0;
    if (n > 0) {
      job.applied.add(globalRef);
      job.filled += n;
      sendMapProgress({
        type: "MAP_PROGRESS",
        phase: "generating",
        message: `Filled ${job.filled} of ${job.total} AI field(s)…`,
      });
    }
  } catch (e) {
    log.debug("smart fill apply failed (tab closed/navigated?)", e);
  }
}

// Stream of answers from the offscreen model. While this port is connected the
// SW is kept alive, so a multi-minute fill is never torn down mid-job.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SMART_FILL_PORT) return;
  port.onMessage.addListener((msg: SmartFillStream) => {
    if (msg.type === "FIELD" && activeSmartFill) void applyField(activeSmartFill, msg.ref, msg.value);
  });
});

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

/** Validate + kick off a Smart Fill job. Returns an error string, or null when started. */
async function startSmartFill(req: Extract<BgRequest, { type: "SMART_FILL" }>): Promise<string | null> {
  if (!req.fields.length) return "no fields to fill";
  const settings = await getSettings();
  if (settings.safety.masterKillSwitch) return "JobSmith is paused (kill switch on)";
  if (!settings.llm.enabled) return "On-device AI is off";

  const offErr = await ensureOffscreen();
  if (offErr) return offErr;

  activeSmartFill = {
    tabId: req.tabId,
    highlight: req.highlight,
    total: req.fields.length,
    filled: 0,
    applied: new Set(),
  };
  // Run in the background; the offscreen's open stream port keeps us alive.
  void runSmartFill(req, settings.resume, settings.llm.model, settings.llm.temperature);
  return null;
}

async function runSmartFill(
  req: Extract<BgRequest, { type: "SMART_FILL" }>,
  resume: ResumeData,
  model: string,
  temperature: number,
): Promise<void> {
  try {
    const resp = await sendToOffscreen({
      target: "offscreen",
      type: "MAP_FIELDS",
      fields: req.fields,
      resume,
      model,
      temperature,
      ...(req.jd ? { jd: req.jd } : {}),
    });

    // Safety net: apply anything the live stream didn't deliver (e.g. the port
    // dropped). applyField skips refs already written, so nothing double-counts.
    if (activeSmartFill && resp.map) {
      for (const [ref, value] of Object.entries(resp.map)) {
        await applyField(activeSmartFill, ref, value);
      }
    }

    const filled = activeSmartFill?.filled ?? 0;
    sendMapProgress({
      type: "MAP_PROGRESS",
      phase: "generating",
      done: true,
      message:
        resp.engine === "none"
          ? `AI unavailable: ${resp.error || resp.note || "unknown"}.`
          : `Filled ${filled} AI field(s). Review everything before you submit.`,
    });
  } catch (e) {
    log.warn("smart fill run failed", e);
    sendMapProgress({
      type: "MAP_PROGRESS",
      phase: "generating",
      done: true,
      message: `Smart Fill failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  } finally {
    activeSmartFill = null;
  }
}

/* --------------------------------- alarms -------------------------------- */

async function scheduleAlarms(): Promise<void> {
  const settings = await getSettings();
  const period = clamp(settings.jobSearch.pollFrequencyMinutes, MIN_POLL_MINUTES, MAX_POLL_MINUTES);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: period, delayInMinutes: period });
  chrome.alarms.create(REMINDER_ALARM, {
    periodInMinutes: REMINDER_PERIOD_MINUTES,
    delayInMinutes: 1,
  });
  log.info(`alarms scheduled: poll every ${period}m, reminders every ${REMINDER_PERIOD_MINUTES}m`);
}

/* -------------------------------- polling -------------------------------- */

interface PollSummary {
  ok: boolean;
  newCount: number;
  total: number;
  error?: string;
}

async function runPoll(force: boolean): Promise<PollSummary> {
  try {
    const settings = await getSettings();
    if (settings.safety.masterKillSwitch) {
      log.info("poll skipped: master kill switch on");
      return { ok: false, newCount: 0, total: 0, error: "kill switch on" };
    }
    if (!settings.jobSearch.enabled) {
      log.info("poll skipped: job search disabled");
      return { ok: false, newCount: 0, total: 0, error: "job search disabled" };
    }

    const [providerState, seen, prior] = await Promise.all([
      getProviderState(),
      getSeenJobs(),
      getJobsCache(),
    ]);
    const result = await pollJobs(settings, providerState, { force });
    await setProviderState(result.providerState);

    const matchedJobs = result.matched.map((m) => m.job);
    const newJobs = matchedJobs.filter((j) => !(j.id in seen));

    // Merge by source rather than replace. Providers have different intervals,
    // so most cycles only run SOME of them — replacing the whole cache with just
    // this cycle's matches would drop every listing from a provider that didn't
    // run (and wipe everything on a cycle where nothing was due). Instead:
    // refresh the listings from providers that ran, keep the rest (including
    // "scan" results the user added). Fresh matches lead (they're score-sorted).
    const ranSources = new Set(result.ran);
    const retained = prior.filter((j) => !ranSources.has(j.source));
    const merged = dedupeById([...matchedJobs, ...retained]);

    await setJobsCache(merged);
    await markJobsSeen(matchedJobs.map((j) => j.id));

    if (newJobs.length > 0) {
      notifyNewJobs(newJobs, settings.notifications);
      await updateBadge(newJobs.length);
    }

    log.info(
      `poll: ${result.ran.length} ran, ${matchedJobs.length} matched, ${newJobs.length} new, ${merged.length} cached`,
    );
    return { ok: true, newCount: newJobs.length, total: merged.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error("poll failed", error);
    return { ok: false, newCount: 0, total: 0, error };
  }
}

/* ----------------------------- scanned jobs ------------------------------ */
// Jobs the user surfaced by clicking "Scan this page" on a career page or a
// LinkedIn/Indeed results page they were already viewing. These bypass the
// search-criteria filter (the user chose this page deliberately) and are merged
// into the popup cache so they rank against the résumé like polled listings.

async function addScannedJobs(scraped: ScrapedJob[], sourceLabel: string): Promise<BgResponse> {
  const now = Date.now();
  const label = sourceLabel.trim() || "Scanned page";
  const fresh: Job[] = scraped
    .filter((j) => j.title && j.url)
    .map((j) =>
      buildJob({
        source: "scan",
        sourceLabel: label,
        title: j.title,
        company: j.company ?? "",
        url: j.url,
        description: j.description ?? "",
        location: j.location ?? "",
        postedAt: j.postedAt,
        now,
      }),
    );

  const existing = await getJobsCache();
  const seenIds = new Set(existing.map((j) => j.id));
  const added = fresh.filter((j) => !seenIds.has(j.id));
  // New scans lead the cache so they're visible without scrolling.
  const merged = [...added, ...existing];
  await setJobsCache(merged);
  await markJobsSeen(merged.map((j) => j.id));

  log.info(`scan: ${fresh.length} found, ${added.length} new from "${label}"`);
  return { type: "SCAN_RESULT", added: added.length, total: fresh.length };
}

/* --------------------------- custom source test -------------------------- */
// Fetch a single custom source so the options page can show the user whether it
// works — and, when it's an unscrapeable JavaScript career page, auto-detect the
// ATS (Greenhouse/Lever/Ashby/SmartRecruiters) behind it.

function testContext(): ProviderContext {
  const http = createHttp();
  return {
    roles: [],
    keywords: [],
    customSources: [],
    now: Date.now(),
    log: createLogger("custom-test"),
    fetchJson: http.fetchJson,
    fetchText: http.fetchText,
  };
}

/** A few links scraped off a JS career page are usually junk — below this we
 *  prefer an auto-detected ATS if one exists. */
const PAGE_TRUST_THRESHOLD = 5;

async function resolveCustomSource(url: string, label: string): Promise<BgResponse> {
  const ctx = testContext();
  const source: CustomSource = { id: "test", label, url, enabled: true };
  const resolved = parseCustomSource(url);
  const isAts = !("error" in resolved) && resolved.kind !== "page";

  const ok = (jobs: Job[]): BgResponse => ({
    type: "RESOLVE_RESULT",
    ok: true,
    count: jobs.length,
    samples: jobs.slice(0, 5).map((j) => j.title),
  });

  // Try the URL as given.
  let direct: Job[] = [];
  try {
    direct = await fetchCustomSource(source, ctx);
  } catch (e) {
    log.debug("custom source direct fetch failed", e);
  }

  // An explicit ATS/feed that returns jobs is trusted as-is. A generic page with
  // a healthy number of listings is trusted too.
  if (isAts && direct.length > 0) return ok(direct);
  if (!isAts && direct.length >= PAGE_TRUST_THRESHOLD) return ok(direct);

  // Otherwise probe for the ATS behind the domain (the SPA case) and prefer it
  // when it clearly has more listings than the page scrape.
  const match = await probeAtsForUrl(url, ctx);
  if (match && match.count > direct.length) {
    const jobs = await fetchCustomSource({ ...source, url: match.boardUrl }, ctx).catch(() => []);
    return {
      type: "RESOLVE_RESULT",
      ok: true,
      count: match.count,
      samples: jobs.slice(0, 5).map((j) => j.title),
      suggestedUrl: match.boardUrl,
      detected: `${match.kind}: ${match.token}`,
    };
  }

  if (direct.length > 0) return ok(direct);
  return {
    type: "RESOLVE_RESULT",
    ok: false,
    count: 0,
    samples: [],
    error:
      "No jobs found and no ATS detected. If this is a JavaScript career page, open it and use “Scan this page”.",
  };
}

/** Keep the first occurrence of each job id (fresh matches lead the list). */
function dedupeById(jobs: Job[]): Job[] {
  const seen = new Set<string>();
  const out: Job[] = [];
  for (const job of jobs) {
    if (seen.has(job.id)) continue;
    seen.add(job.id);
    out.push(job);
  }
  return out;
}

/* --------------------------- detect & add (popup) ------------------------ */
// The popup hands us ATS links it found on the page the user is viewing (plus
// the page URL). We resolve the first one that's a real ATS board with jobs,
// add it as a tracked custom source, and surface its jobs immediately.

async function detectAndAdd(
  pageUrl: string,
  candidates: string[],
  providedLabel: string,
): Promise<BgResponse> {
  const ctx = testContext();

  // Try explicit ATS links found on the page first, then the page URL itself.
  const tryList = dedupeStrings([...candidates, pageUrl]);
  for (const url of tryList) {
    const resolved = parseCustomSource(url);
    if ("error" in resolved || resolved.kind === "page") continue; // only real ATS
    const storeUrl = canonicalSourceUrl(url);
    const label = (resolved.token || providedLabel || "").trim();
    try {
      const jobs = await fetchCustomSource({ id: "d", label, url: storeUrl, enabled: true }, ctx);
      if (jobs.length > 0) return addDetectedSource(storeUrl, label, resolved.kind, jobs);
    } catch (e) {
      log.debug(`detect candidate failed: ${url}`, e);
    }
  }

  // Fallback: probe by domain (for SPAs that don't link out to their ATS).
  const match = await probeAtsForUrl(pageUrl, ctx);
  if (match) {
    const jobs = await fetchCustomSource(
      { id: "d", label: match.token, url: match.boardUrl, enabled: true },
      ctx,
    ).catch(() => []);
    if (jobs.length > 0) return addDetectedSource(match.boardUrl, match.token, match.kind, jobs);
  }

  return {
    type: "DETECT_RESULT",
    added: false,
    count: 0,
    error:
      "No known ATS (Greenhouse/Lever/Ashby/SmartRecruiters/Workday) found on this page. Use “Scan this page” to grab what's on screen instead.",
  };
}

/** Persist a detected source and merge its current listings into the cache. */
async function addDetectedSource(
  url: string,
  label: string,
  kind: string,
  jobs: Job[],
): Promise<BgResponse> {
  const settings = await getSettings();
  const sources = settings.jobSearch.customSources ?? [];
  if (!sources.some((s) => s.url === url)) {
    sources.push({ id: uid("src"), label: label || url, url, enabled: true });
    settings.jobSearch.customSources = sources;
  }
  settings.jobSearch.providers.custom = true;
  await saveSettings(settings);
  await scheduleAlarms();

  // Surface the jobs now so the user sees them without waiting for a poll.
  const prior = await getJobsCache();
  const merged = dedupeById([...jobs, ...prior]);
  await setJobsCache(merged);
  await markJobsSeen(jobs.map((j) => j.id));

  log.info(`detect & add: ${kind}:${label} — added ${jobs.length} jobs`);
  return { type: "DETECT_RESULT", added: true, count: jobs.length, detected: `${kind}: ${label}`, url };
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function updateBadge(newCount: number): Promise<void> {
  try {
    const prev = await chrome.action.getBadgeText({});
    const prevNum = parseInt(prev || "0", 10) || 0;
    const total = prevNum + newCount;
    await chrome.action.setBadgeText({ text: total > 0 ? String(Math.min(total, 999)) : "" });
  } catch (e) {
    log.debug("badge update failed", e);
  }
}

/* ------------------------------- reminders ------------------------------- */

async function runReminders(): Promise<void> {
  try {
    const settings = await getSettings();
    if (settings.safety.masterKillSwitch || !settings.notifications.enabled) return;

    const [apps, reminded] = await Promise.all([getApplications(), getRemindedFollowUps()]);
    const due = dueFollowUps(apps);
    if (due.length === 0) return;

    const remindedSet = new Set(reminded);
    const newlyReminded: string[] = [];
    for (const app of due) {
      const key = followUpKey(app);
      if (remindedSet.has(key)) continue;
      notifyFollowUp(app);
      newlyReminded.push(key);
    }
    if (newlyReminded.length) {
      await setRemindedFollowUps([...reminded, ...newlyReminded]);
      log.info(`reminded ${newlyReminded.length} follow-up(s)`);
    }
  } catch (e) {
    log.error("reminders failed", e);
  }
}
