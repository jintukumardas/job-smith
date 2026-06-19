/**
 * Offscreen document: the headless home for the WebGPU/WebLLM worker used by the
 * "Smart Fill" feature. It receives the field list AND the résumé/model in the
 * request (offscreen docs can't read chrome.storage), runs the on-device model,
 * and returns a ref->value map. Nothing here touches the network except the
 * (data-only) model download.
 */
import { onOffscreenMessage, sendMapProgress } from "../lib/messaging.js";
import { mapFieldsWithLlm } from "../autofill/llm-map.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("offscreen");

// NOTE: offscreen documents can only use chrome.runtime — NOT chrome.storage — so
// the résumé/model/temperature arrive in the request rather than being read here.
onOffscreenMessage(async (req) => {
  log.debug(`mapping ${req.fields.length} field(s)${req.jd ? " with JD context" : ""}`);
  return mapFieldsWithLlm(
    req.resume,
    req.fields,
    req.model,
    req.temperature,
    req.jd,
    sendMapProgress,
  );
});

log.debug("offscreen ready");
