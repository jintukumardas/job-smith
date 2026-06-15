/**
 * Options page. Renders every configuration section, the on-device Resume Studio
 * (where WebLLM runs), and the application tracker. All state is the single
 * Settings object persisted to chrome.storage.local.
 */
import { byId, clear, download, flash, h, mount, parseList } from "../ui/dom.js";
import {
  getLogs,
  clearLogs,
  getSettings,
  saveSettings,
} from "../lib/storage.js";
import { sendToBackground } from "../lib/messaging.js";
import { PROVIDERS } from "../jobs/providers/index.js";
import { resetEngineCache, tailorResume } from "../resume/tailor.js";
import { parseResumeText } from "../resume/parse-resume.js";
import { buildResumeDocument } from "../resume/render.js";
import {
  addApplication,
  deleteApplication,
  listApplications,
  updateApplication,
} from "../tracker/store.js";
import { defaultSettings, DEFAULT_AUTOFILL_FIELDS, DEFAULT_MODEL } from "../lib/defaults.js";
import {
  APP_VERSION,
  APPLICATION_STATUSES,
  type Application,
  type ResumeExperience,
  type Settings,
  type TailoredResume,
} from "../types/index.js";
import { formatDate, formatRelativeTime, uid } from "../lib/util.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("options");

let settings: Settings;
let pendingTailor: { jd: string; title: string; company: string; url: string } | null = null;
let currentSection = "jobs";

/* ------------------------------- bootstrap ------------------------------- */

async function init(): Promise<void> {
  settings = await getSettings();
  byId("version").textContent = `v${APP_VERSION}`;

  const session = (await chrome.storage.session.get(["pendingSection", "pendingTailor"])) as {
    pendingSection?: string;
    pendingTailor?: typeof pendingTailor;
  };
  if (session.pendingTailor) pendingTailor = session.pendingTailor;
  if (session.pendingSection) currentSection = session.pendingSection;
  await chrome.storage.session.remove(["pendingSection", "pendingTailor"]);

  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => switchTo(btn.dataset.section ?? "jobs"));
  });

  // Support deep-link via hash (#applications).
  if (location.hash) {
    const hashed = location.hash.slice(1);
    if (document.querySelector(`.nav-item[data-section="${hashed}"]`)) currentSection = hashed;
  }

  switchTo(currentSection);
}

function switchTo(section: string): void {
  currentSection = section;
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.section === section);
  });
  const view = byId("view");
  clear(view);
  view.appendChild(renderSection(section));
  view.scrollTo({ top: 0 });
}

function renderSection(section: string): HTMLElement {
  switch (section) {
    case "resume":
      return renderResume();
    case "studio":
      return renderStudio();
    case "autofill":
      return renderAutofill();
    case "notifications":
      return renderNotifications();
    case "applications":
      return renderApplications();
    case "privacy":
      return renderPrivacy();
    case "jobs":
    default:
      return renderJobs();
  }
}

/* ----------------------------- UI primitives ----------------------------- */

function page(title: string, lede: string, ...cards: HTMLElement[]): HTMLElement {
  return h("div", {}, h("h1", { text: title }), h("p", { class: "lede", text: lede }), ...cards);
}

function card(title: string, ...children: (HTMLElement | null)[]): HTMLElement {
  return h("div", { class: "card" }, h("h2", { text: title }), ...children.filter(Boolean) as HTMLElement[]);
}

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { text: label }),
    control,
    hint ? h("div", { class: "hint", text: hint }) : null,
  );
}

function textInput(value: string, oninput: (v: string) => void, type = "text"): HTMLInputElement {
  return h("input", { type, value, oninput: (e) => oninput((e.target as HTMLInputElement).value) });
}

function numberInput(
  value: number,
  oninput: (v: number) => void,
  attrs: { min?: number; max?: number; step?: number } = {},
): HTMLInputElement {
  return h("input", {
    type: "number",
    value: String(value),
    min: attrs.min,
    max: attrs.max,
    step: attrs.step,
    oninput: (e) => oninput(Number((e.target as HTMLInputElement).value)),
  });
}

function textArea(value: string, oninput: (v: string) => void, rows = 4): HTMLTextAreaElement {
  return h("textarea", { rows, oninput: (e) => oninput((e.target as HTMLTextAreaElement).value) }, value);
}

// Commit-on-blur variants: use these for fields that persist immediately (the
// tracker), so we write once per edit instead of once per keystroke.
function textInputBlur(value: string, onCommit: (v: string) => void, type = "text"): HTMLInputElement {
  return h("input", { type, value, onchange: (e) => onCommit((e.target as HTMLInputElement).value) });
}

function textAreaBlur(value: string, onCommit: (v: string) => void, rows = 2): HTMLTextAreaElement {
  return h("textarea", { rows, onchange: (e) => onCommit((e.target as HTMLTextAreaElement).value) }, value);
}

function checkRow(
  title: string,
  sub: string,
  checked: boolean,
  onchange: (v: boolean) => void,
): HTMLElement {
  const input = h("input", {
    type: "checkbox",
    checked,
    onchange: (e) => onchange((e.target as HTMLInputElement).checked),
  });
  return h(
    "label",
    { class: "check" },
    input,
    h(
      "div",
      { class: "check-body" },
      h("div", { class: "check-title", text: title }),
      sub ? h("div", { class: "check-sub", text: sub }) : null,
    ),
  );
}

function selectInput(
  options: { value: string; label: string }[],
  current: string,
  onchange: (v: string) => void,
): HTMLSelectElement {
  const sel = h("select", {
    onchange: (e) => onchange((e.target as HTMLSelectElement).value),
  });
  for (const opt of options) {
    sel.appendChild(h("option", { value: opt.value, text: opt.label, selected: opt.value === current }));
  }
  return sel;
}

function saveBar(label: string, onSave: (status: HTMLElement) => void, extra?: HTMLElement): HTMLElement {
  const status = h("span", { class: "flash" });
  const bar = h(
    "div",
    { class: "toolbar" },
    h("button", { class: "action", text: label, onclick: () => onSave(status) }),
    extra ?? null,
    status,
  );
  return bar;
}

async function persist(status: HTMLElement, opts: { reschedule?: boolean } = {}): Promise<void> {
  try {
    await saveSettings(settings);
    if (opts.reschedule) await sendToBackground({ type: "RESCHEDULE" });
    flash(status, "Saved.", "ok");
  } catch (e) {
    log.error("save failed", e);
    flash(status, e instanceof Error ? e.message : "Save failed", "err");
  }
}

function parseLines(value: string): string[] {
  return value.split("\n").map((s) => s.trim()).filter(Boolean);
}

/* -------------------------------- Job search ----------------------------- */

function renderJobs(): HTMLElement {
  const js = settings.jobSearch;
  const providersCard = card("Sources");
  for (const p of PROVIDERS) {
    const hours = (p.minIntervalMinutes / 60).toFixed(p.minIntervalMinutes % 60 ? 1 : 0);
    providersCard.appendChild(
      checkRow(
        p.label,
        `${p.description} · polled at most every ${hours}h. ${p.attribution ?? ""}`,
        js.providers[p.id] ?? false,
        (v) => {
          js.providers[p.id] = v;
        },
      ),
    );
  }

  return page(
    "Job search",
    "Tell JobSmith what to look for. Sources are official public APIs/feeds — no scraping.",
    card(
      "Criteria",
      checkRow("Enable background job polling", "", js.enabled, (v) => (js.enabled = v)),
      field(
        "Roles",
        textInput(js.roles.join(", "), (v) => (js.roles = parseList(v))),
        "Comma-separated. e.g. Software Engineer, Backend Engineer",
      ),
      field(
        "Must-include keywords (optional)",
        textInput(js.keywords.join(", "), (v) => (js.keywords = parseList(v))),
        "A listing must contain at least one of these. Leave blank for no constraint.",
      ),
      field(
        "Exclude keywords",
        textInput(js.excludeKeywords.join(", "), (v) => (js.excludeKeywords = parseList(v))),
        "Listings containing any of these are hidden. e.g. crypto, unpaid",
      ),
      field(
        "Locations",
        textInput(js.locations.join(", "), (v) => (js.locations = parseList(v))),
        "Matched against the listing's location. e.g. worldwide, anywhere, global, india, remote",
      ),
      checkRow("Remote only", "Skip anything not flagged remote.", js.remoteOnly, (v) => (js.remoteOnly = v)),
      field(
        "Check for new jobs every (minutes)",
        numberInput(js.pollFrequencyMinutes, (v) => (js.pollFrequencyMinutes = v), { min: 15, max: 1440 }),
        "Minimum 15. Each source also enforces its own polite minimum interval.",
      ),
    ),
    providersCard,
    saveBar(
      "Save & reschedule",
      (s) => void persist(s, { reschedule: true }),
      h("button", {
        class: "secondary",
        text: "Poll now",
        onclick: async (e) => {
          const btn = e.currentTarget as HTMLButtonElement;
          // Capture the status element synchronously — the view may change before
          // the await resolves.
          const statusEl = byId("view").querySelector(".flash") as HTMLElement | null;
          btn.disabled = true;
          btn.textContent = "Polling…";
          await saveSettings(settings);
          const r = await sendToBackground({ type: "POLL_NOW" });
          btn.disabled = false;
          btn.textContent = "Poll now";
          const ok = r.type === "POLL_RESULT" && r.ok;
          const msg =
            r.type === "POLL_RESULT"
              ? r.ok
                ? `Found ${r.total} matches (${r.newCount} new).`
                : `Couldn't poll: ${r.error ?? "unknown"}`
              : "Error contacting background.";
          if (statusEl) flash(statusEl, msg, ok ? "ok" : "err");
        },
      }),
    ),
  );
}

/* --------------------------------- Resume -------------------------------- */

function renderResume(): HTMLElement {
  const r = settings.resume;

  const importBar = (): HTMLElement => {
    const status = h("span", { class: "flash" });
    return h(
      "div",
      { class: "toolbar" },
      h("button", {
        class: "secondary",
        text: "Import details from pasted text",
        onclick: async () => {
          if (!r.baseResumeText.trim()) {
            flash(status, "Paste your resume above first.", "err");
            return;
          }
          const p = parseResumeText(r.baseResumeText);
          let n = 0;
          if (!r.fullName && p.fullName) { r.fullName = p.fullName; n++; }
          if (!r.headline && p.headline) { r.headline = p.headline; n++; }
          if (!r.email && p.email) { r.email = p.email; n++; }
          if (!r.phone && p.phone) { r.phone = p.phone; n++; }
          if (!r.location && p.location) { r.location = p.location; n++; }
          if (r.links.length === 0 && p.links.length > 0) { r.links = p.links; n++; }
          if (r.skills.length === 0 && p.skills.length > 0) { r.skills = p.skills; n += p.skills.length; }
          if (r.experiences.length === 0 && p.experiences.length > 0) { r.experiences = p.experiences; n += p.experiences.length; }
          if (r.education.length === 0 && p.education.length > 0) { r.education = p.education; n += p.education.length; }
          if (!(r.extraSections?.length) && p.extraSections.length > 0) { r.extraSections = p.extraSections; n += p.extraSections.length; }
          await saveSettings(settings);
          if (n === 0) {
            flash(status, "Nothing new found (fields already filled, or no contact/skills detected).", "err");
          } else {
            switchTo("resume"); // re-render with the imported values shown
          }
        },
      }),
      status,
    );
  };

  const expCard = card("Experience");
  const expList = h("div", {});
  const renderExp = (): void => {
    clear(expList);
    r.experiences.forEach((exp, i) => expList.appendChild(experienceRow(exp, i, renderExp)));
  };
  renderExp();
  expCard.appendChild(expList);
  expCard.appendChild(
    h("button", {
      class: "secondary",
      text: "+ Add experience",
      onclick: () => {
        r.experiences.push({ id: uid("exp"), company: "", title: "", bullets: [], skills: [] });
        renderExp();
      },
    }),
  );

  const eduCard = card("Education");
  const eduList = h("div", {});
  const renderEdu = (): void => {
    clear(eduList);
    r.education.forEach((ed, i) =>
      eduList.appendChild(
        h(
          "div",
          { class: "list-item" },
          h("button", {
            class: "secondary tiny remove",
            text: "✕",
            onclick: () => {
              r.education.splice(i, 1);
              renderEdu();
            },
          }),
          field("Institution", textInput(ed.institution, (v) => (ed.institution = v))),
          h(
            "div",
            { class: "grid-2" },
            field("Degree", textInput(ed.degree ?? "", (v) => (ed.degree = v))),
            field("Year", textInput(ed.year ?? "", (v) => (ed.year = v))),
          ),
        ),
      ),
    );
  };
  renderEdu();
  eduCard.appendChild(eduList);
  eduCard.appendChild(
    h("button", {
      class: "secondary",
      text: "+ Add education",
      onclick: () => {
        r.education.push({ institution: "" });
        renderEdu();
      },
    }),
  );

  const linksCard = card("Links");
  const linksList = h("div", {});
  const renderLinks = (): void => {
    clear(linksList);
    r.links.forEach((lnk, i) =>
      linksList.appendChild(
        h(
          "div",
          { class: "row", style: { marginBottom: "8px" } },
          textInput(lnk.label, (v) => (lnk.label = v)),
          textInput(lnk.url, (v) => (lnk.url = v)),
          h("button", {
            class: "secondary tiny",
            text: "✕",
            onclick: () => {
              r.links.splice(i, 1);
              renderLinks();
            },
          }),
        ),
      ),
    );
  };
  renderLinks();
  linksCard.appendChild(linksList);
  linksCard.appendChild(
    h("button", {
      class: "secondary",
      text: "+ Add link",
      onclick: () => {
        r.links.push({ label: "", url: "" });
        renderLinks();
      },
    }),
  );

  return page(
    "Resume",
    "Your master resume. The Resume Studio tailors a copy of this for each job — your data never leaves the device.",
    card(
      "Basics",
      h(
        "div",
        { class: "grid-2" },
        field("Full name", textInput(r.fullName, (v) => (r.fullName = v))),
        field("Headline", textInput(r.headline, (v) => (r.headline = v))),
      ),
      h(
        "div",
        { class: "grid-2" },
        field("Email", textInput(r.email, (v) => (r.email = v), "email")),
        field("Phone", textInput(r.phone, (v) => (r.phone = v))),
      ),
      field("Location", textInput(r.location, (v) => (r.location = v))),
      field("Professional summary", textArea(r.summary, (v) => (r.summary = v), 3)),
      field(
        "Skills",
        textInput(r.skills.join(", "), (v) => (r.skills = parseList(v))),
        "Comma-separated master skill list.",
      ),
    ),
    expCard,
    eduCard,
    linksCard,
    card(
      "Base resume text",
      h("div", {
        class: "note info",
        text: "Paste your whole resume here, then click Import to auto-fill the fields above. Contact details and skills are extracted automatically; you can edit anything. This text is also used as extra context for tailoring.",
      }),
      field("Paste your full resume", textArea(r.baseResumeText, (v) => (r.baseResumeText = v), 8)),
      importBar(),
    ),
    saveBar("Save resume", (s) => void persist(s)),
  );
}

function experienceRow(exp: ResumeExperience, i: number, rerender: () => void): HTMLElement {
  return h(
    "div",
    { class: "list-item" },
    h("button", {
      class: "secondary tiny remove",
      text: "✕",
      onclick: () => {
        settings.resume.experiences.splice(i, 1);
        rerender();
      },
    }),
    h(
      "div",
      { class: "grid-2" },
      field("Title", textInput(exp.title, (v) => (exp.title = v))),
      field("Company", textInput(exp.company, (v) => (exp.company = v))),
    ),
    h(
      "div",
      { class: "grid-2" },
      field("Start", textInput(exp.startDate ?? "", (v) => (exp.startDate = v))),
      field("End", textInput(exp.endDate ?? "", (v) => (exp.endDate = v))),
    ),
    field("Location", textInput(exp.location ?? "", (v) => (exp.location = v))),
    field(
      "Achievements (one per line)",
      textArea(exp.bullets.join("\n"), (v) => (exp.bullets = parseLines(v)), 4),
    ),
    field("Skills used", textInput(exp.skills.join(", "), (v) => (exp.skills = parseList(v)))),
  );
}

/* ------------------------------ Resume studio ---------------------------- */

function renderStudio(): HTMLElement {
  const llm = settings.llm;
  const jdInput = textArea(pendingTailor?.jd ?? "", () => {}, 8);
  const titleLine = pendingTailor?.title
    ? h("div", { class: "note info", text: `Loaded from: ${pendingTailor.title}${pendingTailor.company ? ` · ${pendingTailor.company}` : ""}` })
    : null;

  const results = h("div", {});
  const progressWrap = h("div", { style: { display: "none" } });
  const progressBar = h("span", {});
  const progressText = h("div", { class: "small muted" });
  progressWrap.appendChild(h("div", { class: "progress" }, progressBar));
  progressWrap.appendChild(progressText);

  const runBtn = h("button", { class: "action", text: "Tailor resume" });
  runBtn.addEventListener("click", async () => {
    const jd = (jdInput as HTMLTextAreaElement).value.trim();
    if (!jd) {
      mount(results, h("div", { class: "note warn", text: "Paste a job description first." }));
      return;
    }
    const hasResume =
      settings.resume.fullName.trim().length > 0 ||
      settings.resume.experiences.length > 0 ||
      settings.resume.baseResumeText.trim().length > 0;
    if (!hasResume) {
      mount(results, h("div", { class: "note warn", text: "Add your resume in the Resume tab first (fill the fields or paste your full resume)." }));
      return;
    }
    runBtn.disabled = true;
    runBtn.textContent = "Tailoring…";
    progressWrap.style.display = "block";
    clear(results);
    try {
      const tailored = await tailorResume(settings.resume, jd, settings, {
        onProgress: (p) => {
          const pct = p.progress != null ? Math.round(p.progress * 100) : undefined;
          progressBar.style.width = pct != null ? `${pct}%` : "100%";
          progressText.textContent =
            p.phase === "loading-model"
              ? `Loading on-device model… ${pct != null ? `${pct}%` : ""} ${p.message ?? ""}`
              : p.phase === "generating"
                ? p.message ?? "Generating…"
                : "Done.";
        },
      });
      renderTailorResult(results, tailored);
    } catch (e) {
      log.error("tailor failed", e);
      mount(results, h("div", { class: "note warn", text: `Tailoring failed: ${e instanceof Error ? e.message : String(e)}` }));
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Tailor resume";
      progressWrap.style.display = "none";
    }
  });

  const engineNote =
    llm.engine === "webllm"
      ? h("div", {
          class: "note info",
          text: "On-device LLM (WebLLM) reads your résumé + the JD and writes the full tailored résumé locally. The first run downloads the model (~GBs) from the public model CDN and caches it; your data is never uploaded. It uses only facts from your résumé (skills it can't support are filtered out), and falls back to the offline engine if WebGPU is unavailable.",
        })
      : h("div", {
          class: "note info",
          text: "Deterministic engine: instant, fully offline, no model download. Reorders your bullets by relevance and composes a tailored summary from your own data.",
        });

  return page(
    "Resume studio",
    "Tailor your resume to a specific job — entirely on your machine.",
    card(
      "Engine",
      engineNote,
      h(
        "div",
        { class: "grid-2" },
        field(
          "Tailoring engine",
          selectInput(
            [
              { value: "webllm", label: "On-device LLM (WebLLM)" },
              { value: "deterministic", label: "Deterministic (offline, instant)" },
            ],
            llm.engine,
            (v) => (llm.engine = v as Settings["llm"]["engine"]),
          ),
        ),
        field(
          "WebLLM model",
          textInput(llm.model, (v) => (llm.model = v)),
          `Default: ${DEFAULT_MODEL} (~2GB, runs on typical machines). Higher quality on a strong GPU (~6GB+): Qwen2.5-7B-Instruct-q4f16_1-MLC. See mlc.ai/models.`,
        ),
      ),
      field(
        "Creativity (temperature)",
        numberInput(llm.temperature, (v) => (llm.temperature = v), { min: 0, max: 1, step: 0.1 }),
      ),
      saveBar("Save engine settings", async (s) => {
        resetEngineCache();
        await persist(s);
      }),
    ),
    card(
      "Tailor",
      titleLine,
      field("Job description", jdInput, "Paste a JD, or use “Tailor” from the popup to auto-capture one."),
      h("div", { class: "toolbar" }, runBtn),
      progressWrap,
      results,
    ),
  );
}

function renderTailorResult(container: HTMLElement, t: TailoredResume): void {
  const matched = h("div", { class: "chips" }, ...t.matchedSkills.map((s) => h("span", { class: "chip", text: s })));
  const missing = h(
    "div",
    { class: "chips" },
    ...t.missingSkills.map((s) => h("span", { class: "chip warn", text: s })),
  );

  const output = h("textarea", { rows: 18, class: "mono" }, t.markdown);
  const accent = h("input", { type: "color", value: deriveAccent(pendingTailor?.company ?? "") });
  const exportStatus = h("span", { class: "flash" });

  mount(
    container,
    h(
      "div",
      { class: "grid-2" },
      h(
        "div",
        {},
        h("div", { class: "small muted", text: "Match score" }),
        h("div", { class: "score", text: `${t.matchScore}%` }),
        h("div", { class: "small muted", text: `Engine: ${t.engine}` }),
      ),
      h(
        "div",
        {},
        h("div", { class: "small muted", text: "Matched skills" }),
        t.matchedSkills.length ? matched : h("div", { class: "small muted", text: "—" }),
        h("div", { class: "small muted", style: { marginTop: "8px" }, text: "Gaps (in JD, not in your resume)" }),
        t.missingSkills.length ? missing : h("div", { class: "small muted", text: "None 🎉" }),
      ),
    ),
    ...t.notes.map((n) => h("div", { class: "note ok small", text: n })),
    h("div", {
      class: "note info small",
      text: "PDF export is a single-column, selectable-text layout — the ATS-safe choice. The accent colour (name + section rules) can match the company; the body stays neutral so parsers read it cleanly.",
    }),
    h("div", { class: "field", style: { marginTop: "12px" } }, h("label", { text: "Tailored resume (Markdown)" }), output),
    h(
      "div",
      { class: "toolbar" },
      h("button", {
        class: "action",
        text: "Save as PDF (ATS-friendly)",
        onclick: () => savePdf(t, accent.value, exportStatus),
      }),
      h("label", { class: "small muted" }, "Accent ", accent),
      h("button", {
        class: "secondary",
        text: "Copy",
        onclick: () => {
          void navigator.clipboard.writeText(output.value);
          flash(exportStatus, "Copied.", "ok");
        },
      }),
      h("button", {
        class: "secondary",
        text: "Download .md",
        onclick: () => download(`resume-${Date.now()}.md`, output.value, "text/markdown"),
      }),
      pendingTailor
        ? h("button", {
            class: "secondary",
            text: "Save as application",
            onclick: async () => {
              await addApplication({
                title: pendingTailor?.title || "Tailored role",
                company: pendingTailor?.company || "",
                url: pendingTailor?.url,
                status: "saved",
                resumeVariant: `tailored-${formatDate(Date.now())}`,
                jobDescription: pendingTailor?.jd,
              });
              await chrome.storage.session.remove("pendingTailor");
              flash(exportStatus, "Saved to Applications.", "ok");
            },
          })
        : null,
      exportStatus,
    ),
  );
}

function savePdf(t: TailoredResume, accentColor: string, status: HTMLElement): void {
  const name =
    settings.resume.fullName ||
    parseResumeText(settings.resume.baseResumeText).fullName ||
    "Resume";
  const doc = buildResumeDocument(t.html, { title: `${name} - Resume`, accent: accentColor });
  const w = window.open("", "_blank", "width=840,height=1080");
  if (!w) {
    flash(status, "Allow pop-ups for this page, then try again.", "err");
    return;
  }
  w.document.open();
  w.document.write(doc);
  w.document.close();
  // Trigger print from the opener (robust even if the new window inherits a CSP
  // that would block an inline script). The user picks "Save as PDF".
  window.setTimeout(() => {
    try {
      w.focus();
      w.print();
    } catch {
      /* user can still print manually */
    }
  }, 350);
  flash(status, "Opened the résumé — use the print dialog and choose “Save as PDF”.", "ok");
}

/** A professional, deterministic accent colour derived from the company name. */
function deriveAccent(company: string): string {
  if (!company.trim()) return "#1f3a8a";
  let hash = 0;
  for (const ch of company) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
  return hslToHex(hash % 360, 60, 32);
}

function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const a = sf * Math.min(lf, 1 - lf);
  const f = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = lf - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/* -------------------------------- Autofill ------------------------------- */

function renderAutofill(): HTMLElement {
  const af = settings.autofill;
  const fieldsCard = card("Fields");
  const list = h("div", {});
  const renderFields = (): void => {
    clear(list);
    af.fields.forEach((f, i) => {
      list.appendChild(
        h(
          "div",
          { class: "list-item" },
          h("button", {
            class: "secondary tiny remove",
            text: "✕",
            onclick: () => {
              af.fields.splice(i, 1);
              renderFields();
            },
          }),
          h(
            "div",
            { class: "grid-2" },
            field("Label", textInput(f.label, (v) => (f.label = v))),
            field("Key", textInput(f.key, (v) => (f.key = v))),
          ),
          field("Value", textInput(f.value, (v) => (f.value = v))),
          field(
            "Match aliases",
            textInput(f.aliases.join(", "), (v) => (f.aliases = parseList(v))),
            "Extra terms used to match this to a form field (name/id/label).",
          ),
          checkRow("Enabled", "", f.enabled, (v) => (f.enabled = v)),
        ),
      );
    });
  };
  renderFields();
  fieldsCard.appendChild(list);
  fieldsCard.appendChild(
    h(
      "div",
      { class: "toolbar" },
      h("button", {
        class: "secondary",
        text: "+ Add field",
        onclick: () => {
          af.fields.push({ key: "", label: "", value: "", aliases: [], enabled: true });
          renderFields();
        },
      }),
      h("button", {
        class: "secondary",
        text: "Reset to defaults",
        onclick: () => {
          af.fields = DEFAULT_AUTOFILL_FIELDS.map((f) => ({ ...f, aliases: [...f.aliases] }));
          renderFields();
        },
      }),
    ),
  );

  return page(
    "Autofill",
    "JobSmith fills empty fields when you click “Autofill form” — it never overwrites your input and never submits.",
    card(
      "Behavior",
      checkRow("Enable autofill", "", af.enabled, (v) => (af.enabled = v)),
      checkRow("Highlight filled fields", "Outline fields JobSmith touched so you can review.", af.highlightFilled, (v) => (af.highlightFilled = v)),
      field(
        "Disabled on these sites",
        textArea(af.perSiteDisabled.join("\n"), (v) => (af.perSiteDisabled = parseLines(v)), 3),
        "One hostname per line, e.g. careers.example.com",
      ),
    ),
    fieldsCard,
    saveBar("Save autofill", (s) => void persist(s)),
  );
}

/* ----------------------------- Notifications ----------------------------- */

function renderNotifications(): HTMLElement {
  const n = settings.notifications;
  const quietEnabled = n.quietHours != null;
  const quietWrap = h("div", { style: { display: quietEnabled ? "block" : "none" } });
  const rebuildQuiet = (): void => {
    clear(quietWrap);
    if (!n.quietHours) return;
    quietWrap.appendChild(
      h(
        "div",
        { class: "grid-2" },
        field("Quiet from (hour 0-23)", numberInput(n.quietHours.start, (v) => (n.quietHours!.start = clampHour(v)), { min: 0, max: 23 })),
        field("Quiet until (hour 0-23)", numberInput(n.quietHours.end, (v) => (n.quietHours!.end = clampHour(v)), { min: 0, max: 23 })),
      ),
    );
  };
  rebuildQuiet();

  return page(
    "Notifications",
    "Get a desktop notification when new matching jobs appear.",
    card(
      "Preferences",
      checkRow("Enable notifications", "", n.enabled, (v) => (n.enabled = v)),
      checkRow("Only notify about new listings", "Avoid repeats you've already seen.", n.onlyNewMatches, (v) => (n.onlyNewMatches = v)),
      field("Max listings per notification", numberInput(n.maxPerBatch, (v) => (n.maxPerBatch = v), { min: 1, max: 20 })),
      checkRow("Quiet hours", "Suppress notifications during a daily window.", quietEnabled, (v) => {
        n.quietHours = v ? { start: 22, end: 7 } : null;
        quietWrap.style.display = v ? "block" : "none";
        rebuildQuiet();
      }),
      quietWrap,
    ),
    saveBar(
      "Save notifications",
      (s) => void persist(s),
      h("button", {
        class: "secondary",
        text: "Send test notification",
        onclick: () => void sendToBackground({ type: "TEST_NOTIFICATION" }),
      }),
    ),
  );
}

function clampHour(v: number): number {
  return Math.max(0, Math.min(23, Math.round(v) || 0));
}

/* ----------------------------- Applications ------------------------------ */

function renderApplications(): HTMLElement {
  const root = page(
    "Applications",
    "Track everything you've saved or applied to. Stored locally only.",
  );
  const container = card("Tracked roles");
  root.appendChild(container);

  const refresh = async (): Promise<void> => {
    const apps = await listApplications();
    clear(container);
    container.appendChild(h("h2", { text: `Tracked roles (${apps.length})` }));
    container.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "secondary",
          text: "+ Add manually",
          onclick: async () => {
            await addApplication({ title: "New role", company: "" });
            await refresh();
          },
        }),
        h("button", {
          class: "secondary",
          text: "Export JSON",
          onclick: () => download("applications.json", JSON.stringify(apps, null, 2), "application/json"),
        }),
        h("button", {
          class: "secondary",
          text: "Export CSV",
          onclick: () => download("applications.csv", toCsv(apps), "text/csv"),
        }),
      ),
    );
    if (apps.length === 0) {
      container.appendChild(h("p", { class: "muted", text: "Nothing tracked yet." }));
      return;
    }
    for (const app of apps) container.appendChild(applicationRow(app, refresh));
  };
  void refresh();
  return root;
}

function applicationRow(app: Application, refresh: () => Promise<void>): HTMLElement {
  const statusSel = selectInput(
    APPLICATION_STATUSES.map((s) => ({ value: s, label: s })),
    app.status,
    async (v) => {
      await updateApplication(app.id, { status: v as Application["status"] });
    },
  );
  return h(
    "div",
    { class: "list-item" },
    h("button", {
      class: "danger tiny remove",
      text: "Delete",
      onclick: async () => {
        await deleteApplication(app.id);
        await refresh();
      },
    }),
    h(
      "div",
      { class: "grid-2" },
      field("Role", textInputBlur(app.title, (v) => void updateApplication(app.id, { title: v }))),
      field("Company", textInputBlur(app.company, (v) => void updateApplication(app.id, { company: v }))),
    ),
    h(
      "div",
      { class: "grid-2" },
      field("Status", statusSel),
      field(
        "Follow-up reminder",
        h("input", {
          type: "date",
          value: toDateInput(app.followUpAt),
          onchange: (e) => void updateApplication(app.id, { followUpAt: fromDateInput((e.target as HTMLInputElement).value) }),
        }),
      ),
    ),
    app.url
      ? h("div", { class: "small" }, h("a", { href: app.url, target: "_blank", rel: "noopener", text: app.url }))
      : null,
    field("Notes", textAreaBlur(app.notes ?? "", (v) => void updateApplication(app.id, { notes: v }), 2)),
    h("div", {
      class: "small muted",
      text: `Saved ${formatRelativeTime(app.createdAt)}${app.appliedAt ? ` · applied ${formatDate(app.appliedAt)}` : ""}`,
    }),
  );
}

function toDateInput(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromDateInput(value: string): number | null {
  if (!value) return null;
  const t = Date.parse(`${value}T12:00:00`);
  return Number.isFinite(t) ? t : null;
}

function toCsv(apps: Application[]): string {
  const head = ["title", "company", "status", "url", "createdAt", "appliedAt", "followUpAt", "notes"];
  const esc = (v: unknown): string => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = apps.map((a) =>
    [
      a.title,
      a.company,
      a.status,
      a.url ?? "",
      formatDate(a.createdAt),
      a.appliedAt ? formatDate(a.appliedAt) : "",
      a.followUpAt ? formatDate(a.followUpAt) : "",
      (a.notes ?? "").replace(/\n/g, " "),
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...rows].join("\n");
}

/* ----------------------------- Privacy & safety -------------------------- */

function renderPrivacy(): HTMLElement {
  const logsBox = h("div", { class: "logs" });
  const refreshLogs = async (): Promise<void> => {
    const logs = await getLogs();
    clear(logsBox);
    if (logs.length === 0) {
      logsBox.appendChild(h("div", { class: "muted", text: "No logs yet." }));
      return;
    }
    for (const entry of logs.slice(-150).reverse()) {
      logsBox.appendChild(
        h("div", {
          class: `log-line ${entry.level}`,
          text: `${new Date(entry.ts).toLocaleTimeString()} [${entry.scope}] ${entry.message}`,
        }),
      );
    }
  };
  void refreshLogs();

  const importInput = h("input", { type: "file", style: { display: "none" } });
  importInput.accept = "application/json";
  importInput.addEventListener("change", async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Settings>;
      settings = { ...defaultSettings(), ...parsed, schemaVersion: defaultSettings().schemaVersion };
      await saveSettings(settings);
      await sendToBackground({ type: "RESCHEDULE" });
      switchTo("privacy");
    } catch (e) {
      log.error("import failed", e);
    }
  });

  return page(
    "Privacy & safety",
    "JobSmith is built to help you apply faster without risking your reputation.",
    card(
      "Our guarantees",
      h(
        "ul",
        {},
        liText("100% local. No accounts, no servers, no analytics. Your resume and personal data never leave this browser."),
        liText("Only official, public job APIs/feeds are used — no scraping of sites that forbid it."),
        liText("Polite, rate-limited polling that respects each source's terms (the anti-blacklist guarantee)."),
        liText("Autofill never submits forms, never clicks buttons, and never overwrites values you typed."),
        liText("A visible disclosure is shown in-page whenever autofill runs."),
      ),
    ),
    card(
      "Controls",
      checkRow(
        "Show automation disclosure",
        "Display an in-page banner whenever autofill runs.",
        settings.safety.automationDisclosure,
        (v) => (settings.safety.automationDisclosure = v),
      ),
      checkRow(
        "Pause everything (master kill switch)",
        "Stops job polling, notifications and autofill until turned off.",
        settings.safety.masterKillSwitch,
        (v) => (settings.safety.masterKillSwitch = v),
      ),
      saveBar("Save controls", (s) => void persist(s, { reschedule: true })),
    ),
    card(
      "Your data",
      h(
        "div",
        { class: "toolbar" },
        h("button", {
          class: "secondary",
          text: "Export all settings",
          onclick: () => download("jobsmith-settings.json", JSON.stringify(settings, null, 2), "application/json"),
        }),
        h("button", { class: "secondary", text: "Import settings", onclick: () => importInput.click() }),
        importInput,
        h("button", {
          class: "danger",
          text: "Reset to defaults",
          onclick: async () => {
            if (!confirm("Reset all JobSmith settings to defaults? Applications are kept.")) return;
            settings = defaultSettings();
            await saveSettings(settings);
            await sendToBackground({ type: "RESCHEDULE" });
            switchTo("privacy");
          },
        }),
      ),
    ),
    card(
      "Activity log",
      logsBox,
      h(
        "div",
        { class: "toolbar" },
        h("button", { class: "secondary", text: "Refresh", onclick: () => void refreshLogs() }),
        h("button", {
          class: "secondary",
          text: "Clear logs",
          onclick: async () => {
            await clearLogs();
            await refreshLogs();
          },
        }),
      ),
    ),
  );
}

function liText(text: string): HTMLElement {
  return h("li", { text });
}

/* -------------------------------- start ---------------------------------- */

document.addEventListener("DOMContentLoaded", () => {
  init().catch((e) => log.error("options init failed", e));
});
