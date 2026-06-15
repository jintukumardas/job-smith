/**
 * Lightweight structured logger.
 *
 * Always writes to the console (visible in the relevant DevTools context) and,
 * when running inside the extension, persists a capped ring buffer of entries
 * to `chrome.storage.local` so they can be inspected from the options page.
 */
import type { LogEntry, LogLevel } from "../types/index.js";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MAX_PERSISTED = 250;
const LOGS_KEY = "logs";

let minLevel: LogLevel = "debug";
let persist = true;

export function configureLogger(opts: { minLevel?: LogLevel; persist?: boolean }): void {
  if (opts.minLevel) minLevel = opts.minLevel;
  if (typeof opts.persist === "boolean") persist = opts.persist;
}

function hasStorage(): boolean {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.storage &&
    !!chrome.storage.local &&
    typeof chrome.storage.local.get === "function"
  );
}

// Serialize persistence to avoid lost updates from concurrent log calls.
let persistChain: Promise<void> = Promise.resolve();

function persistEntry(entry: LogEntry): void {
  if (!persist || !hasStorage()) return;
  persistChain = persistChain
    .then(async () => {
      const stored = (await chrome.storage.local.get(LOGS_KEY)) as {
        logs?: LogEntry[];
      };
      const logs = Array.isArray(stored.logs) ? stored.logs : [];
      logs.push(entry);
      if (logs.length > MAX_PERSISTED) logs.splice(0, logs.length - MAX_PERSISTED);
      await chrome.storage.local.set({ [LOGS_KEY]: logs });
    })
    .catch(() => {
      /* never let logging throw */
    });
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export function createLogger(scope: string): Logger {
  function emit(level: LogLevel, message: string, data?: unknown): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;
    const entry: LogEntry = { ts: Date.now(), level, scope, message };
    if (data !== undefined) entry.data = safeData(data);

    const prefix = `[JobSmith:${scope}]`;
    const args = data !== undefined ? [prefix, message, data] : [prefix, message];
    if (level === "error") console.error(...args);
    else if (level === "warn") console.warn(...args);
    else if (level === "info") console.info(...args);
    else console.debug(...args);

    persistEntry(entry);
  }

  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
  };
}

/** Make data JSON-safe (errors -> message, drop functions/cycles). */
function safeData(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message };
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}
