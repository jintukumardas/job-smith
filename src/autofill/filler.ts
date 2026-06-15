/**
 * In-page autofill. Runs inside the content script (needs the DOM).
 *
 * Safety guarantees baked in here:
 *  - Only EMPTY controls are filled — your typed values are never overwritten.
 *  - Passwords, files, hidden, radios, checkboxes, submit/buttons are skipped.
 *  - Values are set via the native setter + input/change events so React/Vue
 *    forms register them, but NO form is ever submitted and NO button clicked.
 */
import type { AutofillField } from "../types/index.js";
import type { FilledFieldReport } from "../lib/messaging.js";
import {
  bestFieldMatch,
  type FieldDescriptor,
  type ProfileFieldDef,
} from "./matcher.js";
import { truncate } from "../lib/util.js";

export const HIGHLIGHT_CLASS = "jobsmith-filled";

const FILLABLE_INPUT_TYPES = new Set([
  "",
  "text",
  "email",
  "tel",
  "url",
  "number",
  "search",
]);

type Fillable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface FillResult {
  report: FilledFieldReport[];
  /** Matched controls left untouched because they already had a value. */
  skipped: number;
}

export function fillForm(fields: AutofillField[], highlight: boolean): FillResult {
  const usable = fields.filter((f) => f.enabled && f.value.trim().length > 0);
  const defs: ProfileFieldDef[] = usable.map((f) => ({
    key: f.key,
    label: f.label,
    aliases: f.aliases,
  }));
  const valueByKey = new Map(usable.map((f) => [f.key, f.value] as const));
  const labelByKey = new Map(usable.map((f) => [f.key, f.label] as const));

  const report: FilledFieldReport[] = [];
  let skipped = 0;

  for (const el of collectControls()) {
    const desc = describe(el);
    const match = bestFieldMatch(desc, defs);
    if (!match) continue;
    const value = valueByKey.get(match.field.key);
    if (value === undefined) continue;

    if (hasValue(el)) {
      skipped += 1;
      continue;
    }

    const ok = applyValue(el, value);
    if (!ok) continue;

    if (highlight) markFilled(el);
    report.push({
      key: match.field.key,
      label: labelByKey.get(match.field.key) ?? match.field.key,
      field: describeControl(desc),
      valuePreview: truncate(value, 48),
    });
  }

  return { report, skipped };
}

export function clearHighlights(): void {
  document
    .querySelectorAll<HTMLElement>(`.${HIGHLIGHT_CLASS}`)
    .forEach((el) => el.classList.remove(HIGHLIGHT_CLASS));
}

/* ------------------------------- collection ------------------------------ */

function collectControls(): Fillable[] {
  const nodes = document.querySelectorAll<Fillable>("input, textarea, select");
  const out: Fillable[] = [];
  for (const el of Array.from(nodes)) if (isFillable(el)) out.push(el);
  return out;
}

function isFillable(el: Fillable): boolean {
  if (el.disabled || (el as HTMLInputElement).readOnly) return false;
  if (!isVisible(el)) return false;
  if (el instanceof HTMLInputElement) {
    return FILLABLE_INPUT_TYPES.has((el.type || "text").toLowerCase());
  }
  return el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}

function isVisible(el: HTMLElement): boolean {
  if (el.hidden) return false;
  const rects = el.getClientRects();
  if (rects.length === 0) return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style && (style.visibility === "hidden" || style.display === "none")) return false;
  return true;
}

function hasValue(el: Fillable): boolean {
  if (el instanceof HTMLSelectElement) {
    const v = el.value;
    return v.trim().length > 0 && el.selectedIndex > 0;
  }
  return el.value.trim().length > 0;
}

/* -------------------------------- describe ------------------------------- */

function describe(el: Fillable): FieldDescriptor {
  return {
    name: el.getAttribute("name") ?? "",
    id: el.id ?? "",
    placeholder: el.getAttribute("placeholder") ?? "",
    ariaLabel: el.getAttribute("aria-label") ?? "",
    labelText: getLabelText(el),
    autocomplete: el.getAttribute("autocomplete") ?? "",
    type: (el as HTMLInputElement).type ?? "text",
  };
}

function getLabelText(el: Fillable): string {
  const parts: string[] = [];
  if (el.id) {
    const forLabel = el.ownerDocument.querySelector(`label[for="${cssEscape(el.id)}"]`);
    if (forLabel?.textContent) parts.push(forLabel.textContent);
  }
  const wrapping = el.closest("label");
  if (wrapping?.textContent) parts.push(wrapping.textContent);

  const labelledby = el.getAttribute("aria-labelledby");
  if (labelledby) {
    for (const id of labelledby.split(/\s+/)) {
      const ref = el.ownerDocument.getElementById(id);
      if (ref?.textContent) parts.push(ref.textContent);
    }
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, 120);
}

function describeControl(desc: FieldDescriptor): string {
  return (
    desc.labelText ||
    desc.ariaLabel ||
    desc.placeholder ||
    desc.name ||
    desc.id ||
    desc.type ||
    "field"
  ).slice(0, 60);
}

function cssEscape(value: string): string {
  const w = window as unknown as { CSS?: { escape?: (s: string) => string } };
  if (w.CSS?.escape) return w.CSS.escape(value);
  return value.replace(/["\\\]\[#.:>~+*^$=|()]/g, "\\$&");
}

/* --------------------------------- apply --------------------------------- */

function applyValue(el: Fillable, value: string): boolean {
  if (el instanceof HTMLSelectElement) return applySelect(el, value);
  setNativeValue(el, value);
  dispatch(el);
  return true;
}

function applySelect(el: HTMLSelectElement, value: string): boolean {
  const target = value.toLowerCase().trim();
  const options = Array.from(el.options);
  const match =
    options.find((o) => o.value.toLowerCase() === target || o.text.toLowerCase() === target) ??
    options.find(
      (o) => o.text.toLowerCase().includes(target) || target.includes(o.text.toLowerCase()),
    );
  if (!match) return false;
  el.value = match.value;
  dispatch(el);
  return true;
}

/** Set value through the prototype setter so React's value tracker updates. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatch(el: Fillable): void {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function markFilled(el: Fillable): void {
  el.classList.add(HIGHLIGHT_CLASS);
}
