/**
 * Pure, unit-tested matching of a DOM form control to a profile field.
 *
 * It combines three signals: the HTML `autocomplete` token (authoritative when
 * present), exact name/id matches, and fuzzy token/substring overlap across
 * name/id/placeholder/aria-label/associated <label> text. No DOM here — the
 * content script collects a {@link FieldDescriptor} and calls this.
 */

export interface FieldDescriptor {
  name: string;
  id: string;
  placeholder: string;
  ariaLabel: string;
  labelText: string;
  autocomplete: string;
  type: string;
  /** ATS data-* hooks (data-automation-id, data-qa, data-test, data-testid). */
  testId: string;
}

export interface ProfileFieldDef {
  key: string;
  label: string;
  aliases: string[];
}

/** Standard HTML autocomplete tokens -> our canonical profile keys. */
const AUTOCOMPLETE_MAP: Record<string, string> = {
  "given-name": "firstName",
  "additional-name": "firstName",
  "family-name": "lastName",
  name: "fullName",
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  "street-address": "address",
  "address-line1": "address",
  "address-level2": "city",
  "address-level1": "state",
  "country-name": "country",
  country: "country",
  "postal-code": "postalCode",
  organization: "currentCompany",
  "organization-title": "currentTitle",
  url: "portfolio",
};

const TYPE_HINT: Record<string, string> = {
  email: "email",
  tel: "phone",
  url: "portfolio",
};

const SCORE = {
  autocomplete: 120,
  attrExact: 70,
  token: 30,
  substring: 14,
  typeHint: 18,
};

export const MIN_MATCH_SCORE = 30;

function tokensOf(...values: string[]): Set<string> {
  const set = new Set<string>();
  for (const v of values) {
    for (const t of v.toLowerCase().split(/[^a-z0-9]+/)) if (t) set.add(t);
  }
  return set;
}

function collapse(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function terms(field: ProfileFieldDef): string[] {
  // Key + aliases only (NOT the human label) so generic words like "name" don't
  // leak into every field; aliases declare specificity explicitly.
  return [field.key, ...field.aliases];
}

export function scoreFieldMatch(desc: FieldDescriptor, field: ProfileFieldDef): number {
  // 1) Authoritative autocomplete token (trim so "email " still maps).
  const ac = desc.autocomplete.trim().toLowerCase().split(/\s+/).pop() ?? "";
  if (ac && AUTOCOMPLETE_MAP[ac] === field.key) return SCORE.autocomplete;

  const descTokens = tokensOf(
    desc.name,
    desc.id,
    desc.placeholder,
    desc.ariaLabel,
    desc.labelText,
    desc.testId,
  );
  const descCollapsed = collapse(
    [desc.name, desc.id, desc.placeholder, desc.ariaLabel, desc.labelText, desc.testId].join(" "),
  );
  const nameId = [collapse(desc.name), collapse(desc.id), collapse(desc.testId)].filter(Boolean);

  let best = 0;
  for (const raw of terms(field)) {
    const term = raw.toLowerCase().trim();
    if (!term) continue;
    const termCollapsed = collapse(term);
    if (!termCollapsed) continue;
    const lenFactor = Math.min(20, termCollapsed.length * 2);

    if (nameId.includes(termCollapsed)) {
      best = Math.max(best, SCORE.attrExact + lenFactor);
      continue;
    }
    const singleToken = !/[^a-z0-9]/.test(term);
    if (singleToken && descTokens.has(term)) {
      best = Math.max(best, SCORE.token + lenFactor);
      continue;
    }
    if (termCollapsed.length >= 4 && descCollapsed.includes(termCollapsed)) {
      best = Math.max(best, SCORE.substring + lenFactor);
    }
  }

  // 4) input type hint (email/tel/url).
  const typeKey = TYPE_HINT[desc.type.toLowerCase()];
  if (typeKey && typeKey === field.key) best += SCORE.typeHint;

  return best;
}

export interface FieldMatch {
  field: ProfileFieldDef;
  score: number;
}

/** Best profile field for a control, or null if nothing clears the threshold. */
export function bestFieldMatch(
  desc: FieldDescriptor,
  fields: ProfileFieldDef[],
): FieldMatch | null {
  let best: FieldMatch | null = null;
  for (const field of fields) {
    const score = scoreFieldMatch(desc, field);
    if (score >= MIN_MATCH_SCORE && (!best || score > best.score)) {
      best = { field, score };
    }
  }
  return best;
}
