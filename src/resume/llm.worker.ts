/**
 * Dedicated WebLLM worker. Runs the on-device model with WebGPU (available in
 * dedicated workers) and speaks the {@link LlmToWorker}/{@link LlmFromWorker}
 * protocol. This is the ONLY module that imports @mlc-ai/web-llm, so the heavy
 * dependency lands only in this bundle.
 *
 * Model weights are fetched once from the public MLC/HuggingFace CDN and cached
 * by the browser. Your resume text is only ever sent to THIS worker — it never
 * leaves the device.
 */
import {
  CreateMLCEngine,
  type MLCEngineInterface,
  type InitProgressReport,
} from "@mlc-ai/web-llm";
import type { LlmToWorker, LlmFromWorker } from "./llm-protocol.js";

// tsconfig uses the DOM lib; cast the worker global to avoid lib juggling.
const ctx: {
  onmessage: ((ev: MessageEvent<LlmToWorker>) => void) | null;
  postMessage: (msg: LlmFromWorker) => void;
} = self as never;

let engine: MLCEngineInterface | null = null;
let currentModel = "";

function post(msg: LlmFromWorker): void {
  ctx.postMessage(msg);
}

ctx.onmessage = async (ev: MessageEvent<LlmToWorker>): Promise<void> => {
  const msg = ev.data;
  try {
    if (msg.type === "init") {
      if (engine && currentModel === msg.model) {
        post({ id: msg.id, type: "ready" });
        return;
      }
      if (engine) {
        try {
          await engine.unload();
        } catch {
          /* ignore */
        }
        engine = null;
      }
      engine = await CreateMLCEngine(msg.model, {
        initProgressCallback: (r: InitProgressReport) => {
          post({ id: msg.id, type: "progress", progress: r.progress ?? 0, text: r.text ?? "" });
        },
      });
      currentModel = msg.model;
      post({ id: msg.id, type: "ready" });
      return;
    }

    if (msg.type === "chat") {
      if (!engine) throw new Error("Model not initialized");
      const completion = await engine.chat.completions.create({
        messages: msg.messages,
        temperature: msg.temperature,
        max_tokens: msg.maxTokens,
        stream: false,
      });
      const content = completion.choices?.[0]?.message?.content ?? "";
      post({ id: msg.id, type: "result", content });
      return;
    }
  } catch (e) {
    post({ id: msg.id, type: "error", error: e instanceof Error ? e.message : String(e) });
  }
};
