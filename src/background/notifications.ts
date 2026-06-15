/**
 * Notification helpers. The target URL is encoded into the notification id so a
 * click can open it even if the service worker was restarted in the meantime.
 */
import type { Application, Job, NotificationSettings, QuietHours } from "../types/index.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("notifications");
const ID_PREFIX = "jobsmith::";

function iconUrl(): string {
  return chrome.runtime.getURL("icons/icon128.png");
}

export function isQuietHours(q: QuietHours | null, date = new Date()): boolean {
  if (!q) return false;
  const { start, end } = q;
  if (start === end) return false;
  const h = date.getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

function makeId(url: string): string {
  return `${ID_PREFIX}${Date.now()}::${url}`;
}

function urlFromId(id: string): string | null {
  if (!id.startsWith(ID_PREFIX)) return null;
  const idx = id.indexOf("::", ID_PREFIX.length);
  return idx >= 0 ? id.slice(idx + 2) : null;
}

export function notifyNewJobs(jobs: Job[], settings: NotificationSettings): void {
  if (!settings.enabled || jobs.length === 0) return;
  if (isQuietHours(settings.quietHours)) {
    log.debug("suppressed job notification (quiet hours)");
    return;
  }
  const top = jobs.slice(0, Math.max(1, settings.maxPerBatch));
  const title =
    jobs.length === 1
      ? `New match: ${top[0].title}`
      : `${jobs.length} new job matches`;
  const message = top
    .map((j) => `• ${j.title} — ${j.company}${j.location ? ` (${j.location})` : ""}`)
    .join("\n");
  const target = top[0].url || chrome.runtime.getURL("options.html");

  chrome.notifications.create(makeId(target), {
    type: "basic",
    iconUrl: iconUrl(),
    title,
    message: message.slice(0, 500),
    priority: 1,
  });
}

export function notifyFollowUp(app: Application): void {
  const target = app.url || chrome.runtime.getURL("options.html#applications");
  chrome.notifications.create(makeId(target), {
    type: "basic",
    iconUrl: iconUrl(),
    title: `Follow up: ${app.company || app.title}`,
    message: `Time to follow up on your ${app.title} application.`,
    priority: 2,
  });
}

export function notifyTest(): void {
  chrome.notifications.create(makeId(chrome.runtime.getURL("options.html")), {
    type: "basic",
    iconUrl: iconUrl(),
    title: "JobSmith notifications are on",
    message: "You'll be alerted here when new matching jobs appear.",
    priority: 1,
  });
}

/** Wire up notification clicks to open the encoded URL. Call once at startup. */
export function registerNotificationClicks(): void {
  chrome.notifications.onClicked.addListener((id) => {
    const url = urlFromId(id);
    if (url) chrome.tabs.create({ url }).catch((e) => log.warn("open tab failed", e));
    chrome.notifications.clear(id);
  });
}
