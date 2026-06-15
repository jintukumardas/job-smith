/**
 * Resume-tailoring engine contract. Two implementations:
 *  - WebLLMEngine — an on-device LLM (WebGPU) that AUTHORS the tailored resume.
 *  - DeterministicEngine — always-available offline fallback (rule-based).
 *
 * Both return a {@link TailoredContent} that the renderer turns into Markdown,
 * ATS-friendly HTML and a PDF.
 */
import type {
  JdAnalysis,
  ResumeData,
  ResumeEducation,
  ResumeEngineKind,
  ResumeExperience,
  ResumeLink,
  ResumeSection,
} from "../types/index.js";

export interface EngineProgress {
  phase: "loading-model" | "generating" | "done";
  /** 0..1 when known. */
  progress?: number;
  message?: string;
}

export interface TailorRequest {
  /** Resume already enriched from pasted text (see parse-resume `enrichResume`). */
  resume: ResumeData;
  jd: string;
  analysis: JdAnalysis;
  /** Canonical skills the resume actually evidences. */
  resumeSkills: string[];
  matchedSkills: string[];
  missingSkills: string[];
  temperature: number;
  onProgress?: (p: EngineProgress) => void;
  signal?: AbortSignal;
}

/** The full, tailored resume content an engine produces. */
export interface TailoredContent {
  fullName: string;
  headline: string;
  email: string;
  phone: string;
  location: string;
  links: ResumeLink[];
  summary: string;
  /** Skills, most relevant first. */
  skills: string[];
  experiences: ResumeExperience[];
  education: ResumeEducation[];
  /** Extra sections (Achievements, Projects, Certifications…). */
  extraSections: ResumeSection[];
}

export interface EngineTailorResult {
  content: TailoredContent;
  notes: string[];
}

export interface ResumeEngine {
  readonly kind: ResumeEngineKind;
  isAvailable(): Promise<boolean>;
  tailor(req: TailorRequest): Promise<EngineTailorResult>;
  dispose(): void;
}

/** Identity/contact fields are taken verbatim from the resume, never authored. */
export function identityFrom(
  resume: ResumeData,
): Pick<TailoredContent, "fullName" | "headline" | "email" | "phone" | "location" | "links"> {
  return {
    fullName: resume.fullName,
    headline: resume.headline,
    email: resume.email,
    phone: resume.phone,
    location: resume.location,
    links: resume.links,
  };
}

/** Build the source text the LLM reads (prefers the user's pasted resume). */
export function serializeResumeForLlm(resume: ResumeData): string {
  const text = resume.baseResumeText.trim() ? resume.baseResumeText : serializeStructured(resume);
  return text.slice(0, 8000);
}

function serializeStructured(resume: ResumeData): string {
  const p: string[] = [];
  if (resume.fullName) p.push(resume.fullName);
  const contact = [resume.email, resume.phone, resume.location].filter(Boolean).join(" | ");
  if (contact) p.push(contact);
  if (resume.headline) p.push(resume.headline);
  if (resume.summary) p.push(`SUMMARY\n${resume.summary}`);
  if (resume.skills.length) p.push(`SKILLS\n${resume.skills.join(", ")}`);
  if (resume.experiences.length) {
    p.push("EXPERIENCE");
    for (const e of resume.experiences) {
      const dates = [e.startDate, e.endDate].filter(Boolean).join(" - ");
      p.push(`${e.title}${e.company ? ` at ${e.company}` : ""}${dates ? ` (${dates})` : ""}`);
      for (const b of e.bullets) p.push(`- ${b}`);
    }
  }
  if (resume.education.length) {
    p.push("EDUCATION");
    for (const ed of resume.education) {
      p.push([ed.degree, ed.institution, ed.year].filter(Boolean).join(", "));
    }
  }
  for (const section of resume.extraSections ?? []) {
    p.push(section.heading.toUpperCase());
    for (const item of section.items) p.push(`- ${item}`);
  }
  return p.join("\n");
}
