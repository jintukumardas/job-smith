# JobSmith — Local-First Job Search Assistant (Chrome MV3)

JobSmith helps you run a faster, saner job search **without sending a single byte of your
personal data to anyone**. It tracks remote job listings, tailors your résumé to each job
**on your own machine** (in-browser LLM via WebGPU, with an offline fallback), and politely
auto-fills application forms — *without* the bot-like behavior that gets people blacklisted.

> **Privacy in one sentence:** there is no server. No accounts, no analytics, no telemetry.
> Your résumé, your contact details, and the job descriptions you tailor against never leave
> your browser. The only network calls are to **public job APIs/feeds** and a **one-time model
> download** (which contains no personal data).

---

## Table of contents

- [Features](#features)
- [How it stays ethical (anti-blacklist design)](#how-it-stays-ethical-anti-blacklist-design)
- [Install](#install)
- [Configure](#configure)
- [Use it](#use-it)
- [On-device résumé tailoring (WebLLM)](#on-device-résumé-tailoring-webllm)
- [Job sources & their terms](#job-sources--their-terms)
- [Architecture](#architecture)
- [Development](#development)
- [Troubleshooting](#troubleshooting)
- [Limitations & FAQ](#limitations--faq)
- [License](#license)

---

## Features

| Area | What it does |
| --- | --- |
| **Job notifications** | Polls public remote-job sources on a schedule and sends a desktop notification when new listings match your role/location/keyword criteria. Fully configurable; per-source rate limits enforced. |
| **Résumé tailoring** | Parses a job description, finds your matching/missing skills, and rewrites a tailored résumé **locally** — either with an in-browser LLM (WebLLM/WebGPU) or a deterministic offline engine. Export a clean **ATS-friendly PDF** (single column, selectable text, optional company accent colour), or copy/download Markdown. |
| **Paste-to-fill résumé** | Paste your whole résumé once; JobSmith extracts name, contact, location and skills into structured fields (one click), which then feed both tailoring and autofill. |
| **Auto-fill** | On click, fills empty application fields using values **derived automatically from your résumé** (name, email, phone, location, links, current role) — explicit overrides still win. Matches by `autocomplete`, name/id, label, and ATS `data-*` hooks, and injects into **all frames** so iframe-embedded forms (Greenhouse) work. **Never overwrites your input. Never submits. Never clicks buttons.** |
| **Smart Fill (AI)** | For fields the matcher can't recognize, the on-device LLM reads their labels and maps them to your résumé (strictly from your data — no fabrication). Runs in an offscreen WebGPU worker; falls back gracefully when unavailable. |
| **Application tracker** | Log saved/applied roles, statuses, dates, notes and follow-up reminders. Export to JSON/CSV. |
| **Follow-up reminders** | Desktop reminders when a follow-up date is due. |
| **Config page** | Everything is configurable: criteria, sources, résumé, autofill fields, notifications, engine, privacy. |
| **Privacy & safety controls** | Master kill switch, automation disclosure toggle, activity log viewer, full settings export/import/reset. |

---

## How it stays ethical (anti-blacklist design)

These are deliberate, load-bearing decisions — not afterthoughts:

- **Official public APIs/feeds only.** JobSmith reads documented, public endpoints
  (Remotive, Remote OK, Arbeitnow, We Work Remotely RSS, the HN "Who is hiring?" Algolia API).
  It does **not** scrape sites that forbid it, and it does not log into anything.
- **Polite, rate-limited polling.** Each source declares a minimum interval (e.g. Remotive is
  polled at most every 6 hours, in line with their request to fetch only a few times a day).
  The background poller honors these regardless of your UI frequency setting.
- **Attribution & backlinks.** Sources that require it (Remotive, Remote OK) are credited on
  every listing, and you're always sent to the original listing URL.
- **Autofill is assistive, not automated.** It fills **empty** fields only, on an explicit
  click, then shows an in-page disclosure banner. It **never** submits forms or clicks buttons,
  so it won't trip anti-bot measures or misrepresent you.
- **No background page injection.** There are no always-on content scripts and no broad host
  permissions. The content script is injected **only** into the current tab, **only** when you
  invoke an action (`activeTab` + `scripting`).
- **A master kill switch** disables polling, notifications and autofill instantly.

---

## Install

JobSmith is distributed as source you build and load unpacked.

```bash
# 1. Install dependencies
npm install

# 2. Build to dist/
npm run build
```

Then in Chrome (or any Chromium browser):

1. Go to `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`dist/`** folder.
4. Pin JobSmith and click it to open the popup; click the ⚙ to open **Settings**.

> **WebGPU:** on-device LLM tailoring needs a WebGPU-capable browser (Chrome 120+ on a
> reasonably modern GPU). If WebGPU isn't available, JobSmith automatically falls back to the
> offline deterministic engine — everything else still works.

To produce a zip for sharing: `npm run package` → `job-smith.zip`.

---

## Configure

Open **Settings** (⚙ in the popup) and work through the tabs:

1. **Job search** — roles, optional keywords, exclude terms, acceptable locations
   (e.g. `worldwide, anywhere, global, india, remote`), remote-only, which sources to use,
   and how often to check. Click **Poll now** to fetch immediately.
2. **Résumé** — your master résumé as structured data: basics, summary, skills, experiences
   (one achievement per line), education, links. Optionally paste your full résumé text for
   extra context.
3. **Résumé studio** — pick the engine (WebLLM or deterministic), paste/﻿capture a JD, and
   tailor. See [below](#on-device-résumé-tailoring-webllm).
4. **Autofill** — the field catalogue (key, value, match aliases). Fill in your details once.
   Add per-site disables if needed.
5. **Notifications** — enable, batch size, quiet hours, and a test button.
6. **Applications** — your tracker.
7. **Privacy & safety** — guarantees, kill switch, disclosure toggle, data export/import/reset,
   and the activity log.

**Quick start:** you can import a ready-made profile from
[`examples/settings.example.json`](examples/settings.example.json) via
**Privacy & safety → Import settings**, then edit it.

---

## Use it

**Get notified about jobs**
Configure criteria → JobSmith polls in the background → you get a notification with the top
matches → click it to open the listing. The popup shows the latest matches with **Open**,
**Tailor**, and **Track** actions; the toolbar badge shows how many are new.

**Set up your résumé once**
Settings → **Résumé**: fill the fields, or just paste your whole résumé into **Base resume text**
and click **Import details from pasted text** — JobSmith extracts your name, contact, location and
skills into the fields (review/edit, then Save). Those values power both tailoring and autofill.

**Tailor your résumé to a posting**
On a job page, open the popup and click **Tailor resume** — JobSmith captures the JD and opens
the Résumé Studio with it pre-filled. Or click **Tailor** on any listing in the popup. Hit
**Tailor resume**, review the match score / matched / missing skills, then **Save as PDF
(ATS-friendly)** — pick an accent colour to match the company; the body stays single-column and
selectable so applicant-tracking systems parse it cleanly. You can also **Copy**, **Download .md**,
or **Save as application**.

**Auto-fill an application**
On a careers/application page, open the popup and click **Autofill form**. JobSmith fills the
empty fields it confidently recognizes — using values pulled straight from your résumé — across
all frames (so iframe-embedded ATS forms like Greenhouse work), highlights them, and shows a
disclosure banner. For fields it doesn't recognize (custom ATS questions), click **Smart Fill
(AI)**: the on-device model reads those labels and maps them to your résumé. **Review everything
and submit yourself.** Use **Clear highlights** to remove the outlines.

You only fill your details once — on the **Résumé** tab. The autofill catalogue (Settings →
Autofill) auto-populates from it; set a field's value there only to override the résumé.

**Track applications & follow-ups**
Use **Track this page** / **Track**, or add entries manually in the Applications tab. Set a
**follow-up reminder** date to get a desktop nudge when it's due.

---

## On-device résumé tailoring (WebLLM)

JobSmith ships two interchangeable engines behind one interface:

- **WebLLM (default).** Runs an open LLM entirely in the browser via WebGPU, inside a dedicated
  Web Worker. On first use it downloads the model weights from the public MLC/Hugging Face CDN
  (one-time, ~GBs depending on the model) and caches them. Your résumé and the JD are only ever
  posted to that local worker — **no personal data is uploaded**. The model is instructed to use
  *only* facts present in your résumé and never to invent employers, titles or metrics.
- **Deterministic (fallback / opt-in).** Instant, fully offline, zero download. It extracts JD
  keywords/skills, reorders your existing bullets by relevance, and composes a tailored summary
  from your own data. Used automatically whenever WebGPU or the model is unavailable.

**Changing the model:** Résumé Studio → *WebLLM model*. The default is
`Llama-3.2-3B-Instruct-q4f16_1-MLC` (good quality/size). For faster, smaller downloads try
`Llama-3.2-1B-Instruct-q4f32_1-MLC`; for higher quality try an 8B model. See
<https://mlc.ai/models> for valid ids. Saving the engine settings resets the warm model.

---

## Job sources & their terms

| Source | Type | Min interval | Notes |
| --- | --- | --- | --- |
| **Remotive** | JSON API | 6h | Attribution + backlink required; data delayed ~24h. |
| **Remote OK** | JSON API | 6h | Follow backlink + credit required. |
| **We Work Remotely** | RSS | 2h | Programming category feed. |
| **Arbeitnow** | JSON API | 3h | Europe-leaning; off by default. |
| **HN "Who is hiring?"** | Algolia API | 12h | Heuristic parsing of free-text posts; off by default. |

JobSmith complies with each source's stated terms: it credits them, links back to original
listings, and never republishes their data anywhere (it only displays it to you).

---

## Architecture

```
src/
  manifest.json            # MV3 manifest (version injected at build)
  types/                   # all shared domain types
  lib/                     # logger, typed storage, defaults, messaging, DOM-free utils
  jobs/
    provider.ts            # JobProvider contract + normalization
    rss.ts                 # dependency-free RSS parser (service workers have no DOMParser)
    providers/             # remotive, remoteok, wwr, arbeitnow, hn + registry
    filter.ts              # role/keyword/location matching + scoring (pure)
    aggregator.ts          # rate-limited polling cycle
  resume/
    skills.ts              # skill dictionary + detection (pure)
    jd-parser.ts           # JD → keywords/skills/requirements (pure)
    engine.ts              # ResumeEngine interface
    deterministic.ts       # offline engine
    webllm.ts + llm.worker.ts + llm-protocol.ts   # on-device LLM engine
    render.ts              # tailored résumé → Markdown (pure)
    tailor.ts              # orchestration + skill match + scoring
  autofill/
    matcher.ts             # DOM field → profile key matching, incl. ATS data-* hooks (pure)
    profile.ts             # derive autofill values from the résumé (pure)
    filler.ts              # safe in-page filling (empty-only, no submit) + field collection
    llm-map.ts             # map unmatched fields to résumé via the on-device LLM
  content/                 # on-demand, all-frames content API + overlay styles
  offscreen/               # headless WebGPU/WebLLM host for Smart Fill
  background/              # service worker, alarms, notifications
  popup/  options/  ui/    # UI
test/                      # vitest unit tests for all the pure logic
examples/                  # importable example settings + résumé
build.mjs                  # esbuild bundler + pure-JS PNG icon generator
```

Design choices worth knowing:

- **esbuild, IIFE bundles.** Every entry point is a self-contained bundle — no ESM/worker
  quirks in the MV3 runtime. The heavy WebLLM dependency lands only in `llm.worker.js`.
- **One storage module.** `lib/storage.ts` is the only thing that touches `chrome.storage`,
  with defaults-merging so settings migrate safely.
- **Pure cores, tested.** Matching, parsing, scoring, RSS and rendering are side-effect-free and
  covered by unit tests; the impure shells (DOM, network, chrome.*) stay thin.

---

## Development

```bash
npm run dev         # rebuild on change (sourcemaps, no minify)
npm run build       # production build → dist/
npm run typecheck   # tsc --noEmit (strict)
npm test            # vitest (67 tests)
npm run lint        # eslint
npm run package     # build + zip → job-smith.zip
```

After `npm run dev`, reload the extension at `chrome://extensions` to pick up changes
(the background service worker and content scripts reload on extension reload).

---

## Troubleshooting

- **"Can't autofill on this page."** You're on a restricted page (`chrome://`, the Web Store,
  etc.) or autofill is disabled for that site. Normal pages work after you click an action.
- **Autofill filled nothing.** It only fills **empty** fields it recognizes. Add/adjust the
  field **aliases** in Settings → Autofill to match that site's field names.
- **WebLLM is slow / falls back.** The first run downloads the model — subsequent runs are fast.
  If you see "used the offline engine," your browser lacks WebGPU; switch to a WebGPU-capable
  browser or use the deterministic engine.
- **No job notifications.** Check Settings: job search enabled, at least one source on,
  notifications enabled, and the kill switch off. Press **Poll now**. Sources can also be empty
  if your criteria are very narrow.
- **Model download blocked.** Corporate networks may block the model CDN. Use the deterministic
  engine, or allowlist `*.huggingface.co` and `raw.githubusercontent.com`.

---

## Limitations & FAQ

- **It does not apply for you.** By design. It assists; you review and submit. That's what keeps
  you off blacklists and keeps your applications honest.
- **Autofill coverage varies by ATS.** Standard fields on Lever, Greenhouse, Ashby and Workday
  (name, email, phone, links, company, location) are matched directly; iframe-embedded forms are
  handled via all-frames injection. Highly custom widgets (some Workday combo-boxes) may still
  need manual entry — try **Smart Fill (AI)** for those.
- **Smart Fill needs WebGPU.** It runs the on-device model in an offscreen document; if WebGPU
  isn't available it simply does nothing extra (deterministic autofill still runs).
- **JD capture is heuristic.** Pages vary; if capture misses, paste the JD into Résumé Studio.
- **HN parsing is best-effort.** Free-text posts don't have clean fields; that source is off by
  default.
- **PDF export favours ATS-safety over heavy branding.** The exported PDF is single-column with
  selectable text and standard fonts (what parsers read reliably); company "theme" is limited to a
  tasteful accent colour. Multi-column, graphic-heavy templates look nicer but get mangled by ATS.
- **Résumé import is structured, not PDF-parsed.** Enter your résumé as fields (or paste text). This
  gives the tailoring engine clean data and avoids brittle PDF parsing.
- **Is my data really local?** Yes. Inspect `lib/storage.ts` (everything is `chrome.storage.local`)
  and the network calls in `jobs/providers/*` and `resume/llm.worker.ts`. There is no backend.

---

## License

MIT — see [LICENSE](LICENSE). Use responsibly and respect each job board's terms of service.
