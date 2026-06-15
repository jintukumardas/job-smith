/**
 * Minimal, dependency-free RSS 2.0 parser.
 *
 * The MV3 service worker has no `DOMParser`, so we parse feeds with regex. These
 * feeds (We Work Remotely et al.) are well-formed RSS, which keeps this simple
 * and robust. CDATA sections and HTML entities are handled.
 */
import { decodeEntities } from "../lib/util.js";

export interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
  guid?: string;
  region?: string;
  categories: string[];
}

export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  if (!xml) return items;
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const item: RssItem = {
      title: tagText(block, "title"),
      link: tagText(block, "link") || attrLink(block),
      description: tagText(block, "description") || tagText(block, "content:encoded"),
      categories: allTagText(block, "category"),
    };
    const pubDate = tagText(block, "pubDate");
    if (pubDate) item.pubDate = pubDate;
    const guid = tagText(block, "guid");
    if (guid) item.guid = guid;
    const region = tagText(block, "region");
    if (region) item.region = region;
    items.push(item);
  }
  return items;
}

function tagText(xml: string, name: string): string {
  const re = new RegExp(`<${escapeTag(name)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(name)}>`, "i");
  const m = re.exec(xml);
  return m ? cleanValue(m[1]) : "";
}

function allTagText(xml: string, name: string): string[] {
  const re = new RegExp(`<${escapeTag(name)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(name)}>`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const v = cleanValue(m[1]);
    if (v) out.push(v);
  }
  return out;
}

/** Atom-style `<link href="…"/>` fallback. */
function attrLink(xml: string): string {
  const m = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/i.exec(xml);
  return m ? decodeEntities(m[1]).trim() : "";
}

function cleanValue(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const value = cdata ? cdata[1] : raw;
  return decodeEntities(value).trim();
}

function escapeTag(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
