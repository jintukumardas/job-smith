/**
 * Message protocol between the resume page (WebLLMEngine) and the dedicated
 * WebLLM worker. Kept in its own module so both sides share the exact types.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type LlmToWorker =
  | { id: number; type: "init"; model: string }
  | {
      id: number;
      type: "chat";
      messages: ChatMessage[];
      temperature: number;
      maxTokens: number;
      /** Kept for back-compat; no longer used to force grammar decoding. */
      json?: boolean;
    };

export type LlmFromWorker =
  | { id: number; type: "progress"; progress: number; text: string }
  | { id: number; type: "ready" }
  /** A streamed token chunk during generation (proves liveness + bounds hangs). */
  | { id: number; type: "delta"; text: string }
  | { id: number; type: "result"; content: string }
  | { id: number; type: "error"; error: string };

/** File name (in dist/) of the bundled worker. */
export const LLM_WORKER_FILE = "llm.worker.js";
