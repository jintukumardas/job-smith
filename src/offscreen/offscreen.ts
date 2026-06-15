/**
 * Offscreen document: the headless home for the WebGPU/WebLLM worker used by the
 * "Smart Fill" feature. It receives field lists, reads the resume from local
 * storage, runs the on-device model, and returns a ref->value map. Nothing here
 * touches the network except the (data-only) model download.
 */
import { onOffscreenMessage } from "../lib/messaging.js";
import { getSettings } from "../lib/storage.js";
import { mapFieldsWithLlm } from "../autofill/llm-map.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("offscreen");

onOffscreenMessage(async (req) => {
  log.debug(`mapping ${req.fields.length} field(s)`);
  const settings = await getSettings();
  if (!settings.llm.enabled) {
    return { map: {}, engine: "none", note: "on-device LLM disabled in settings" };
  }
  return mapFieldsWithLlm(
    settings.resume,
    req.fields,
    settings.llm.model,
    settings.llm.temperature,
  );
});

log.debug("offscreen ready");
