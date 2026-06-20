/**
 * Offscreen document: the headless home for the WebGPU/WebLLM worker used by the
 * "Smart Fill" feature. It receives the field list AND the résumé/model in the
 * request (offscreen docs can't read chrome.storage), runs the on-device model,
 * and returns a ref->value map. Nothing here touches the network except the
 * (data-only) model download.
 */
import { onOffscreenMessage, sendMapProgress, SMART_FILL_PORT } from "../lib/messaging.js";
import type { SmartFillStream } from "../lib/messaging.js";
import { mapFieldsWithLlm } from "../autofill/llm-map.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("offscreen");

// NOTE: offscreen documents can only use chrome.runtime — NOT chrome.storage — so
// the résumé/model/temperature arrive in the request rather than being read here.
onOffscreenMessage(async (req) => {
  log.debug(`mapping ${req.fields.length} field(s)${req.jd ? " with JD context" : ""}`);

  // Stream each answer to the service worker the instant it's produced. While
  // this port is connected it also keeps the SW alive, so the job — and the
  // applying of answers to the page — survives the popup being closed.
  let port: chrome.runtime.Port | null = null;
  try {
    port = chrome.runtime.connect({ name: SMART_FILL_PORT });
  } catch (e) {
    log.warn("could not open smart-fill stream port; falling back to batch result", e);
  }
  const post = (msg: SmartFillStream): void => {
    try {
      port?.postMessage(msg);
    } catch {
      /* SW gone or port closed — the returned map is the fallback */
    }
  };

  // Keep the SW's idle timer from lapsing during a long single-field generation
  // (a 300-word answer can take many seconds with no other port traffic).
  const heartbeat = setInterval(() => post({ type: "PING" }), 20_000);

  try {
    const result = await mapFieldsWithLlm(
      req.resume,
      req.fields,
      req.model,
      req.temperature,
      req.jd,
      sendMapProgress,
      (ref, value) => post({ type: "FIELD", ref, value }),
    );
    post({
      type: "DONE",
      engine: result.engine,
      ...(result.note ? { note: result.note } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    return result;
  } finally {
    clearInterval(heartbeat);
    try {
      port?.disconnect();
    } catch {
      /* already gone */
    }
  }
});

log.debug("offscreen ready");
