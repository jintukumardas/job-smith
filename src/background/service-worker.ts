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
import { clamp } from "../lib/util.js";
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
import type { ResumeData } from "../types/index.js";
import { pollJobs } from "../jobs/aggregator.js";
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

    const [providerState, seen] = await Promise.all([getProviderState(), getSeenJobs()]);
    const result = await pollJobs(settings, providerState, { force });
    await setProviderState(result.providerState);

    const matchedJobs = result.matched.map((m) => m.job);
    const newJobs = matchedJobs.filter((j) => !(j.id in seen));

    await setJobsCache(matchedJobs);
    await markJobsSeen(matchedJobs.map((j) => j.id));

    if (newJobs.length > 0) {
      notifyNewJobs(newJobs, settings.notifications);
      await updateBadge(newJobs.length);
    }

    log.info(`poll: ${matchedJobs.length} matched, ${newJobs.length} new`);
    return { ok: true, newCount: newJobs.length, total: matchedJobs.length };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log.error("poll failed", error);
    return { ok: false, newCount: 0, total: 0, error };
  }
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
