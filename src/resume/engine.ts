/**
 * Resume-tailoring engine contract. Two implementations:
 *  - {@link DeterministicEngine} — always available, offline, rule-based.
 *  - WebLLMEngine — on-device LLM (WebGPU), graceful fallback to deterministic.
 */
import type { JdAnalysis, ResumeData, ResumeEngineKind } from "../types/index.js";

export interface EngineProgress {
  phase: "loading-model" | "generating" | "done";
  /** 0..1 when known. */
  progress?: number;
  message?: string;
}

export interface TailorRequest {
  resume: ResumeData;
  jd: string;
  analysis: JdAnalysis;
  /** Canonical skills the resume already has (normalized). */
  resumeSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  temperature: number;
  onProgress?: (p: EngineProgress) => void;
  signal?: AbortSignal;
}

export interface EngineTailorResult {
  /** Tailored professional summary (plain text). */
  summary: string;
  /** Optional rewritten bullets keyed by experience id. */
  bullets?: Record<string, string[]>;
  notes: string[];
}

export interface ResumeEngine {
  readonly kind: ResumeEngineKind;
  /** Cheap capability probe; WebLLM checks for WebGPU. */
  isAvailable(): Promise<boolean>;
  tailor(req: TailorRequest): Promise<EngineTailorResult>;
  /** Release resources (terminate workers, etc.). */
  dispose(): void;
}

/** Compact, model-friendly serialization of resume experiences. */
export function summarizeExperiences(resume: ResumeData, max = 4): string {
  return resume.experiences
    .slice(0, max)
    .map((e) => {
      const dates = [e.startDate, e.endDate].filter(Boolean).join("–");
      const head = `${e.title} at ${e.company}${dates ? ` (${dates})` : ""}`;
      const bullets = e.bullets.slice(0, 4).map((b) => `  - ${b}`).join("\n");
      return bullets ? `${head}\n${bullets}` : head;
    })
    .join("\n");
}
