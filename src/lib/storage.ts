/**
 * Typed wrapper over `chrome.storage.local`. This is the ONLY place the rest of
 * the code touches storage, which keeps the data model in one spot and makes
 * migrations safe (stored values are always merged over the current defaults).
 */
import type {
  Application,
  CustomSource,
  Job,
  ProviderState,
  Settings,
  StorageKey,
  StorageShape,
} from "../types/index.js";
import { defaultSettings, SCHEMA_VERSION } from "./defaults.js";
import { createLogger } from "./logger.js";

const log = createLogger("storage");

const DEFAULTS: Pick<
  StorageShape,
  "seenJobs" | "jobsCache" | "applications" | "providerState" | "logs" | "remindedFollowUps"
> = {
  seenJobs: {},
  jobsCache: [],
  applications: [],
  providerState: {},
  logs: [],
  remindedFollowUps: [],
};

/** Max distinct job ids retained for "seen" tracking. */
const SEEN_CAP = 4000;
/** Max listings retained in the popup cache. */
const JOBS_CACHE_CAP = 200;

function area(): chrome.storage.LocalStorageArea {
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    throw new Error("chrome.storage.local is unavailable in this context");
  }
  return chrome.storage.local;
}

async function rawGet<K extends StorageKey>(
  key: K,
): Promise<StorageShape[K] | undefined> {
  const result = (await area().get(key)) as Partial<StorageShape>;
  return result[key];
}

async function rawSet<K extends StorageKey>(key: K, value: StorageShape[K]): Promise<void> {
  await area().set({ [key]: value });
}

/* -------------------------------- Settings ------------------------------- */

export async function getSettings(): Promise<Settings> {
  const stored = (await rawGet("settings")) as Partial<Settings> | undefined;
  const merged = mergeSettings(stored);
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  settings.schemaVersion = SCHEMA_VERSION;
  await rawSet("settings", settings);
  log.debug("settings saved");
}

/** Read, transform, and persist settings atomically (best-effort). */
export async function updateSettings(
  mutator: (settings: Settings) => Settings | void,
): Promise<Settings> {
  const current = await getSettings();
  const next = mutator(current) ?? current;
  await saveSettings(next);
  return next;
}

/** Merge stored settings over the current defaults (arrays replace wholesale). */
export function mergeSettings(stored: Partial<Settings> | undefined): Settings {
  const base = defaultSettings();
  if (!stored || typeof stored !== "object") return base;
  return deepMerge(base, stored) as Settings;
}

function deepMerge<T>(base: T, override: Partial<T>): T {
  if (Array.isArray(base) || Array.isArray(override)) {
    return (override ?? base) as T;
  }
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override as Record<string, unknown>)) {
      const o = (override as Record<string, unknown>)[key];
      if (o === undefined) continue;
      const b = (base as Record<string, unknown>)[key];
      out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o as never) : o;
    }
    return out as T;
  }
  return (override ?? base) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* --------------------------------- Jobs ---------------------------------- */

export async function getSeenJobs(): Promise<Record<string, number>> {
  return (await rawGet("seenJobs")) ?? { ...DEFAULTS.seenJobs };
}

export async function markJobsSeen(ids: string[], now = Date.now()): Promise<void> {
  const seen = await getSeenJobs();
  for (const id of ids) if (!(id in seen)) seen[id] = now;
  // Cap by oldest-first eviction.
  const entries = Object.entries(seen);
  if (entries.length > SEEN_CAP) {
    entries.sort((a, b) => a[1] - b[1]);
    const trimmed = entries.slice(entries.length - SEEN_CAP);
    await rawSet("seenJobs", Object.fromEntries(trimmed));
  } else {
    await rawSet("seenJobs", seen);
  }
}

export async function getJobsCache(): Promise<Job[]> {
  return (await rawGet("jobsCache")) ?? [];
}

export async function setJobsCache(jobs: Job[]): Promise<void> {
  await rawSet("jobsCache", jobs.slice(0, JOBS_CACHE_CAP));
}

/**
 * Drop cached custom-source listings that no longer belong to a configured
 * source. Polling only refreshes sources that still exist, so a deleted source's
 * jobs would otherwise linger in the cache (and in the popup's source filter)
 * indefinitely. Call this after the custom-source list changes.
 *
 * Listings are matched by {@link Job.sourceId}; legacy listings cached before
 * that field existed fall back to matching the source's label. Non-custom
 * listings are always retained. Returns the number of jobs removed.
 */
export async function reconcileCustomJobs(sources: CustomSource[]): Promise<number> {
  const cache = await getJobsCache();
  const ids = new Set(sources.map((s) => s.id));
  const labels = new Set(sources.map((s) => s.label.trim()).filter(Boolean));
  const kept = cache.filter((job) => {
    if (job.source !== "custom") return true;
    if (job.sourceId) return ids.has(job.sourceId);
    return labels.has(job.sourceLabel);
  });
  if (kept.length !== cache.length) {
    await rawSet("jobsCache", kept);
    log.debug(`pruned ${cache.length - kept.length} job(s) from removed custom sources`);
  }
  return cache.length - kept.length;
}

/* ----------------------------- Provider state ---------------------------- */

export async function getProviderState(): Promise<Record<string, ProviderState>> {
  return (await rawGet("providerState")) ?? {};
}

export async function setProviderState(
  state: Record<string, ProviderState>,
): Promise<void> {
  await rawSet("providerState", state);
}

/* ----------------------------- Applications ------------------------------ */

export async function getApplications(): Promise<Application[]> {
  return (await rawGet("applications")) ?? [];
}

export async function setApplications(apps: Application[]): Promise<void> {
  await rawSet("applications", apps);
}

/* -------------------------------- Logs ----------------------------------- */

export async function getLogs(): Promise<StorageShape["logs"]> {
  return (await rawGet("logs")) ?? [];
}

export async function clearLogs(): Promise<void> {
  await rawSet("logs", []);
}

/* -------------------------- Reminder bookkeeping ------------------------- */

export async function getRemindedFollowUps(): Promise<string[]> {
  return (await rawGet("remindedFollowUps")) ?? [];
}

export async function setRemindedFollowUps(keys: string[]): Promise<void> {
  // Keep the list bounded.
  await rawSet("remindedFollowUps", keys.slice(-500));
}

/* ------------------------------ Subscriptions ---------------------------- */

/** Subscribe to changes for a single storage key. Returns an unsubscribe fn. */
export function onStorageChanged<K extends StorageKey>(
  key: K,
  handler: (value: StorageShape[K] | undefined) => void,
): () => void {
  const listener = (
    changes: { [name: string]: chrome.storage.StorageChange },
    areaName: string,
  ): void => {
    if (areaName !== "local") return;
    if (key in changes) handler(changes[key].newValue as StorageShape[K] | undefined);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
