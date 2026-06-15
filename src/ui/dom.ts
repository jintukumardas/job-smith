/**
 * Tiny, dependency-free DOM helpers for the popup and options pages.
 * All text goes through textContent/value — never innerHTML — so user data and
 * remote job data can never inject markup.
 */

type Child = Node | string | number | null | undefined | false;

export interface ElAttrs {
  class?: string;
  id?: string;
  type?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  title?: string;
  href?: string;
  target?: string;
  rel?: string;
  for?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  rows?: number;
  checked?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  selected?: boolean;
  text?: string;
  dataset?: Record<string, string>;
  style?: Partial<CSSStyleDeclaration>;
  onclick?: (e: MouseEvent) => void;
  oninput?: (e: Event) => void;
  onchange?: (e: Event) => void;
  onkeydown?: (e: KeyboardEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: ElAttrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined || val === null) continue;
    switch (key) {
      case "class":
        el.className = String(val);
        break;
      case "text":
        el.textContent = String(val);
        break;
      case "dataset":
        Object.assign(el.dataset, val as Record<string, string>);
        break;
      case "style":
        Object.assign(el.style, val as Partial<CSSStyleDeclaration>);
        break;
      case "checked":
      case "disabled":
      case "selected":
      case "readOnly":
        (el as unknown as Record<string, unknown>)[key] = Boolean(val);
        break;
      case "value":
        (el as HTMLInputElement).value = String(val);
        break;
      case "onclick":
      case "oninput":
      case "onchange":
      case "onkeydown": {
        const evt = key.slice(2) as keyof HTMLElementEventMap;
        el.addEventListener(evt, val as EventListener);
        break;
      }
      default:
        el.setAttribute(key, String(val));
    }
  }
  for (const child of children) appendChild(el, child);
  return el;
}

function appendChild(parent: HTMLElement, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (child instanceof Node) parent.appendChild(child);
  else parent.appendChild(document.createTextNode(String(child)));
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

export function mount(parent: HTMLElement, ...children: Child[]): void {
  clear(parent);
  for (const c of children) appendChild(parent, c);
}

/** Trigger a client-side download of text content. */
export function download(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, style: { display: "none" } });
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse a comma/newline separated string into a trimmed, non-empty list. */
export function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A small inline status/toast updater bound to an element. */
export function flash(el: HTMLElement, message: string, kind: "ok" | "err" = "ok"): void {
  el.textContent = message;
  el.className = `flash ${kind}`;
  window.setTimeout(() => {
    if (el.textContent === message) {
      el.textContent = "";
      el.className = "flash";
    }
  }, 3500);
}
