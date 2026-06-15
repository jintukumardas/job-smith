/**
 * JobSmith background service worker (MV3).
 *
 * Responsibilities:
 *  - Schedule + run polite, rate-limited job polling (chrome.alarms).
 *  - Notify about new matches and due follow-ups (respecting the kill switch
 *    and quiet hours).
 *  - Route messages from the popup/options pages.
 *
 * It performs NO active behavior on web pages and never auto-submits anything.
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
import { onBackgroundMessage, type BgResponse } from "../lib/messaging.js";
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
