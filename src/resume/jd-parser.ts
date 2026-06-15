/**
 * Pure job-description analysis: keywords, skills, requirements, seniority and
 * an inferred role. No network, no DOM — fully unit-testable.
 */
import type { JdAnalysis } from "../types/index.js";
import { collapseWhitespace, stripHtml, tokenize, uniqCi } from "../lib/util.js";
import { detectSkills } from "./skills.js";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "of", "to", "in", "on", "for", "with",
  "as", "at", "by", "from", "is", "are", "be", "will", "you", "your", "we", "our", "us", "they",
  "their", "this", "that", "these", "those", "it", "its", "have", "has", "had", "do", "does",
  "did", "can", "may", "must", "should", "would", "could", "about", "into", "over", "under",
  "than", "such", "who", "what", "when", "where", "which", "while", "all", "any", "both", "each",
  "more", "most", "other", "some", "no", "not", "only", "own", "same", "so", "very", "just",
  "work", "working", "team", "teams", "role", "job", "company", "position", "looking", "join",
  "help", "build", "building", "ability", "strong", "good", "great", "excellent", "etc", "years",
  "year", "experience", "experienced", "skills", "skill", "knowledge", "understanding", "plus",
  "including", "include", "across", "within", "well", "new", "using", "use", "like", "ensure",
  "develop", "development", "design", "designing", "support", "via", "per", "also", "able",
  "you'll", "we're", "you're", "and/or",
]);

const SENIORITY_PATTERNS: [string, RegExp][] = [
  ["Principal", /\bprincipal\b/i],
  ["Staff", /\bstaff\b/i],
  ["Lead", /\b(lead|leading a team)\b/i],
  ["Senior", /\b(senior|sr\.?)\b/i],
  ["Mid-level", /\b(mid[- ]?level|intermediate)\b/i],
  ["Junior", /\b(junior|jr\.?|entry[- ]?level|graduate)\b/i],
];

const ROLE_NOUNS =
  /\b(engineer|developer|programmer|architect|scientist|analyst|manager|designer|administrator|specialist|consultant|lead|sre|devops)\b/i;

const REQUIREMENT_HINTS =
  /(\d+\+?\s*years?|must have|required|requirement|you (have|will|should)|we('| a)re looking|proficien|familiar with|hands[- ]on|expertise|strong (background|knowledge)|degree in|bachelor|master|responsib)/i;

export function extractJd(rawInput: string): JdAnalysis {
  const text = collapseWhitespace(stripHtml(rawInput));
  const skills = detectSkills(text);

  const keywords = rankKeywords(text, skills);
  const requirements = extractRequirements(text);
  const seniority = detectSeniority(text);
  const role = inferRole(text);

  const analysis: JdAnalysis = { keywords, skills, requirements };
  if (seniority) analysis.seniority = seniority;
  if (role) analysis.role = role;
  return analysis;
}

function rankKeywords(text: string, skills: string[], limit = 30): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    if (token.length < 3 || STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => word);
  // Skills first (they're the most actionable), then frequency-ranked words.
  return uniqCi([...skills, ...ranked]).slice(0, limit);
}

function extractRequirements(text: string, limit = 12): string[] {
  const pieces = text
    .split(/\n|(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.replace(/^[\s•\-*·]+/, "").trim())
    .filter((s) => s.length >= 12 && s.length <= 240);
  const reqs = pieces.filter((s) => REQUIREMENT_HINTS.test(s));
  return uniqCi(reqs).slice(0, limit);
}

function detectSeniority(text: string): string | undefined {
  for (const [label, re] of SENIORITY_PATTERNS) if (re.test(text)) return label;
  return undefined;
}

function inferRole(text: string): string | undefined {
  const firstLines = text.split("\n").slice(0, 6);
  for (const line of firstLines) {
    const trimmed = line.trim();
    if (trimmed.length >= 4 && trimmed.length <= 80 && ROLE_NOUNS.test(trimmed)) {
      return trimmed.replace(/[:.].*$/, "").trim();
    }
  }
  const m = ROLE_NOUNS.exec(text);
  return m ? m[0] : undefined;
}
