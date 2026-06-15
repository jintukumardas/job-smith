/**
 * Render a tailored resume to Markdown. Pure & unit-testable.
 */
import type { ResumeData, ResumeExperience } from "../types/index.js";

export interface RenderedExperience {
  exp: ResumeExperience;
  bullets: string[];
}

export interface RenderInput {
  resume: ResumeData;
  summary: string;
  /** Skills to surface, most relevant first. */
  orderedSkills: string[];
  /** Experiences in display order with their (possibly rewritten) bullets. */
  experiences: RenderedExperience[];
}

export function renderResumeMarkdown(input: RenderInput): string {
  const { resume } = input;
  const lines: string[] = [];

  lines.push(`# ${resume.fullName || "Your Name"}`);
  if (resume.headline) lines.push(`**${resume.headline}**`);

  const contact = [resume.email, resume.phone, resume.location].filter(Boolean).join(" · ");
  if (contact) lines.push("", contact);

  if (resume.links.length) {
    lines.push(resume.links.map((l) => `[${l.label}](${l.url})`).join(" · "));
  }

  if (input.summary.trim()) {
    lines.push("", "## Summary", "", input.summary.trim());
  }

  if (input.orderedSkills.length) {
    lines.push("", "## Key Skills", "", input.orderedSkills.join(" · "));
  }

  if (input.experiences.length) {
    lines.push("", "## Experience");
    for (const { exp, bullets } of input.experiences) {
      lines.push("", `### ${exp.title}${exp.company ? ` — ${exp.company}` : ""}`);
      const meta = [
        [exp.startDate, exp.endDate].filter(Boolean).join(" – "),
        exp.location,
      ]
        .filter(Boolean)
        .join(" · ");
      if (meta) lines.push(`*${meta}*`);
      lines.push("");
      for (const b of bullets) lines.push(`- ${b}`);
    }
  }

  if (resume.education.length) {
    lines.push("", "## Education");
    for (const ed of resume.education) {
      const parts = [ed.degree, ed.institution].filter(Boolean).join(", ");
      const year = ed.year ? ` (${ed.year})` : "";
      lines.push(`- ${parts}${year}`);
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
