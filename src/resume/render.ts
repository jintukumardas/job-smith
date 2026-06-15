/**
 * Render a tailored resume to Markdown or ATS-friendly HTML. Pure & testable.
 */
import type { ResumeData, ResumeExperience } from "../types/index.js";
import { escapeHtml } from "../lib/util.js";

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

/* ------------------------------- HTML / PDF ------------------------------ */

const SEP = " &nbsp;·&nbsp; ";

/** Render the tailored resume as an ATS-friendly HTML body (single column). */
export function renderResumeHtml(input: RenderInput): string {
  const { resume } = input;
  const e = escapeHtml;
  const parts: string[] = [];

  parts.push('<header class="r-head">');
  parts.push(`<h1 class="r-name">${e(resume.fullName || "Your Name")}</h1>`);
  if (resume.headline) parts.push(`<div class="r-headline">${e(resume.headline)}</div>`);
  const contact = [resume.email, resume.phone, resume.location].filter(Boolean).map(e).join(SEP);
  if (contact) parts.push(`<div class="r-contact">${contact}</div>`);
  if (resume.links.length) {
    const links = resume.links
      .map((l) => `<a href="${e(l.url)}">${e(l.label)}</a>`)
      .join(SEP);
    parts.push(`<div class="r-links">${links}</div>`);
  }
  parts.push("</header>");

  if (input.summary.trim()) {
    parts.push(htmlSection("Summary", `<p class="r-summary">${e(input.summary.trim())}</p>`));
  }
  if (input.orderedSkills.length) {
    parts.push(htmlSection("Key Skills", `<p class="r-skills">${input.orderedSkills.map(e).join(SEP)}</p>`));
  }
  if (input.experiences.length) {
    const body = input.experiences
      .map(({ exp, bullets }) => {
        const head = `${e(exp.title)}${exp.company ? ` — ${e(exp.company)}` : ""}`;
        const meta = [[exp.startDate, exp.endDate].filter(Boolean).join(" – "), exp.location ?? ""]
          .filter(Boolean)
          .map((x) => e(x))
          .join(" · ");
        const ul = bullets.length
          ? `<ul>${bullets.map((b) => `<li>${e(b)}</li>`).join("")}</ul>`
          : "";
        return `<div class="r-exp"><div class="r-exp-head">${head}</div>${
          meta ? `<div class="r-exp-meta">${meta}</div>` : ""
        }${ul}</div>`;
      })
      .join("");
    parts.push(htmlSection("Experience", body));
  }
  if (resume.education.length) {
    const items = resume.education
      .map((ed) => {
        const txt = [ed.degree ?? "", ed.institution].filter(Boolean).map((x) => e(x)).join(", ");
        return `<li>${txt}${ed.year ? ` (${e(ed.year)})` : ""}</li>`;
      })
      .join("");
    parts.push(htmlSection("Education", `<ul>${items}</ul>`));
  }

  return parts.join("\n");
}

function htmlSection(title: string, body: string): string {
  return `<section class="r-section"><h2>${escapeHtml(title)}</h2>${body}</section>`;
}

/** Validate a CSS hex color, falling back to a professional navy. */
export function sanitizeAccent(color: string): string {
  return /^#[0-9a-fA-F]{3,8}$/.test(color.trim()) ? color.trim() : "#1f3a8a";
}

/**
 * Wrap an HTML body in a complete, print-optimized, ATS-friendly document.
 * The document auto-opens the print dialog (Save as PDF). `title` becomes the
 * suggested PDF filename in Chrome.
 */
export function buildResumeDocument(
  bodyHtml: string,
  opts: { title: string; accent: string; autoPrint?: boolean },
): string {
  const accent = sanitizeAccent(opts.accent);
  const css = PRINT_CSS.replace(/__ACCENT__/g, accent);
  // Auto-print is opt-in and only used in contexts where inline script is
  // allowed; the caller usually triggers print() from the opener instead, which
  // avoids any CSP-inheritance issues on the new window.
  const printScript = opts.autoPrint
    ? "<script>window.onload=function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},200);};<\/script>"
    : "";
  return (
    "<!doctype html><html><head><meta charset=\"utf-8\">" +
    `<title>${escapeHtml(opts.title)}</title><style>${css}</style></head>` +
    `<body><main class="resume">${bodyHtml}</main>${printScript}</body></html>`
  );
}

const PRINT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff;color:#111;
  font-family:"Helvetica Neue",Helvetica,Arial,"Liberation Sans",sans-serif;}
.resume{max-width:720px;margin:0 auto;padding:28px 32px;font-size:10.8pt;line-height:1.4;}
.r-name{font-size:23pt;font-weight:700;color:__ACCENT__;margin:0 0 2px;letter-spacing:.2px;}
.r-headline{font-size:12pt;color:#222;margin-bottom:4px;}
.r-contact,.r-links{font-size:10pt;color:#333;}
.r-links a{color:__ACCENT__;text-decoration:none;}
.r-section{margin-top:16px;}
.r-section h2{font-size:11pt;text-transform:uppercase;letter-spacing:.08em;color:#111;
  margin:0 0 8px;padding-bottom:3px;border-bottom:1.5px solid __ACCENT__;}
.r-summary{margin:0;}
.r-skills{margin:0;color:#222;}
.r-exp{margin-bottom:11px;}
.r-exp-head{font-weight:700;font-size:11pt;}
.r-exp-meta{font-size:9.5pt;color:#555;font-style:italic;margin-bottom:3px;}
ul{margin:4px 0 0;padding-left:18px;}
li{margin-bottom:3px;page-break-inside:avoid;}
@page{margin:14mm;}
@media print{.resume{padding:0;max-width:none;}a{color:#111;}}
`;
