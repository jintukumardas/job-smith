/**
 * A pragmatic dictionary of software-industry skills with aliases, used to
 * detect skills in job descriptions and resumes and to normalize them to a
 * canonical name. Not exhaustive — extend freely.
 */
import { uniq } from "../lib/util.js";

/** [canonicalName, ...aliases] */
const SKILL_TABLE: ReadonlyArray<readonly string[]> = [
  // Languages
  ["JavaScript", "js", "ecmascript"],
  ["TypeScript", "ts"],
  ["Python", "py"],
  ["Java"],
  ["Kotlin"],
  ["Go", "golang"],
  ["Rust"],
  ["C++", "cpp", "c plus plus"],
  ["C#", "c sharp", "csharp", "dotnet", ".net"],
  ["C"],
  ["Ruby"],
  ["PHP"],
  ["Scala"],
  ["Swift"],
  ["Objective-C", "objective c"],
  ["SQL"],
  ["Bash", "shell", "shell scripting"],
  ["R"],
  ["Elixir"],
  ["Dart"],
  // Frontend
  ["React", "react.js", "reactjs"],
  ["Next.js", "nextjs", "next js"],
  ["Vue", "vue.js", "vuejs"],
  ["Angular", "angular.js", "angularjs"],
  ["Svelte", "sveltekit"],
  ["Redux"],
  ["HTML", "html5"],
  ["CSS", "css3"],
  ["Tailwind", "tailwindcss", "tailwind css"],
  ["SASS", "scss"],
  ["Webpack"],
  ["Vite"],
  ["React Native", "react-native"],
  ["Flutter"],
  // Backend / frameworks
  ["Node.js", "node", "nodejs"],
  ["Express", "express.js", "expressjs"],
  ["NestJS", "nest.js"],
  ["Django"],
  ["Flask"],
  ["FastAPI", "fast api"],
  ["Spring", "spring boot", "springboot"],
  ["Rails", "ruby on rails", "ror"],
  ["Laravel"],
  ["GraphQL"],
  ["gRPC"],
  ["REST", "rest api", "restful"],
  ["Microservices", "micro services"],
  // Data / DB
  ["PostgreSQL", "postgres", "psql"],
  ["MySQL"],
  ["MongoDB", "mongo"],
  ["Redis"],
  ["Elasticsearch", "elastic search"],
  ["DynamoDB"],
  ["Cassandra"],
  ["Kafka", "apache kafka"],
  ["RabbitMQ"],
  ["Snowflake"],
  ["Spark", "apache spark"],
  ["Airflow", "apache airflow"],
  ["dbt"],
  ["BigQuery"],
  // Cloud / infra
  ["AWS", "amazon web services"],
  ["GCP", "google cloud", "google cloud platform"],
  ["Azure", "microsoft azure"],
  ["Docker"],
  ["Kubernetes", "k8s"],
  ["Terraform"],
  ["Ansible"],
  ["Jenkins"],
  ["CI/CD", "ci cd", "cicd", "continuous integration", "continuous delivery"],
  ["GitHub Actions", "github actions"],
  ["GitLab CI", "gitlab ci"],
  ["Serverless", "lambda", "aws lambda"],
  ["Linux"],
  ["Nginx"],
  ["Prometheus"],
  ["Grafana"],
  ["Datadog"],
  // Practices / domains
  ["Git"],
  ["Agile", "scrum", "kanban"],
  ["TDD", "test driven development"],
  ["Machine Learning", "ml", "machine-learning"],
  ["Deep Learning", "deep-learning"],
  ["Data Science", "data-science"],
  ["NLP", "natural language processing"],
  ["LLM", "llms", "large language model", "large language models"],
  ["TensorFlow", "tensor flow"],
  ["PyTorch", "py torch"],
  ["Pandas"],
  ["NumPy", "numpy"],
  ["System Design", "systems design"],
  ["Distributed Systems", "distributed system"],
  ["DevOps"],
  ["Security", "appsec", "application security", "infosec"],
  ["WebSockets", "websocket"],
  ["OAuth", "oauth2", "openid"],
  ["Accessibility", "a11y", "wcag"],
  ["Figma"],
  ["Jira"],
];

interface SkillDef {
  canonical: string;
  /** Match patterns, longest first, lowercased. */
  patterns: string[];
}

const SKILLS: SkillDef[] = SKILL_TABLE.map(([canonical, ...aliases]) => ({
  canonical,
  patterns: [canonical.toLowerCase(), ...aliases.map((a) => a.toLowerCase())].sort(
    (a, b) => b.length - a.length,
  ),
}));

/** Lookup from any lowercased alias/canonical -> canonical name. */
const ALIAS_TO_CANONICAL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const s of SKILLS) for (const p of s.patterns) m.set(p, s.canonical);
  return m;
})();

function patternToRegex(pattern: string): RegExp {
  // Escape regex specials, then require non-word boundaries around the token so
  // "java" doesn't match inside "javascript". `+`, `#`, `.` are treated as part
  // of the token (C++, C#, Node.js).
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Treat '-' as part of a token on the LEADING side too, so single-letter skills
  // (C, R, Go) don't match inside compounds like "Objective-C" or "ready-to-go".
  return new RegExp(`(^|[^a-z0-9+#.\\-])(${escaped})(?![a-z0-9+#])`, "i");
}

const COMPILED: { canonical: string; re: RegExp }[] = SKILLS.flatMap((s) =>
  s.patterns.map((p) => ({ canonical: s.canonical, re: patternToRegex(p) })),
);

/** Detect canonical skills present in free text (deduped, in table order). */
export function detectSkills(text: string): string[] {
  if (!text) return [];
  const lower = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  for (const { canonical, re } of COMPILED) {
    if (found.has(canonical)) continue;
    if (re.test(lower)) found.add(canonical);
  }
  // Preserve SKILL_TABLE ordering for stable output; uniq() guards against any
  // future duplicate canonical reintroducing a double-emit.
  return uniq(SKILLS.map((s) => s.canonical).filter((c) => found.has(c)));
}

/** Normalize an arbitrary skill string to its canonical name, if recognized. */
export function normalizeSkill(skill: string): string {
  const key = skill.toLowerCase().trim();
  return ALIAS_TO_CANONICAL.get(key) ?? skill.trim();
}

const SKILL_STOP = new Set([
  "and", "or", "the", "of", "with", "for", "to", "in", "on", "a", "an", "using", "based", "via", "amp",
]);

/** Significant lowercase tokens of a skill label ("C++"→{c}, "C#"→{c#}). */
function skillTokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9#]+/).filter((t) => t && !SKILL_STOP.has(t)));
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Collapse near-duplicate / overlapping skills into one per cluster — preferring
 * the more atomic label — and cap the list, so the skills section reads like a
 * curated set instead of a keyword dump. Relevance order is preserved.
 *
 * e.g. ["C/C++", "C++", "C"] -> ["C/C++"], and
 *      ["High Availability & Latency Optimization", "High Availability", "Latency Optimization"]
 *      -> ["High Availability", "Latency Optimization"].
 */
export function curateSkills(skills: string[], cap = 20): string[] {
  const kept: { label: string; tokens: Set<string> }[] = [];
  for (const raw of skills) {
    const label = raw.trim();
    if (!label) continue;
    const tokens = skillTokens(label);
    if (tokens.size === 0) {
      if (!kept.some((k) => k.label.toLowerCase() === label.toLowerCase())) kept.push({ label, tokens });
      continue;
    }
    const idx = kept.findIndex((k) => isSubset(tokens, k.tokens) || isSubset(k.tokens, tokens));
    if (idx < 0) {
      kept.push({ label, tokens });
    } else if (tokens.size < kept[idx].tokens.size && label.length >= 3) {
      kept[idx] = { label, tokens }; // the new label is more atomic — prefer it, in place
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of kept) {
    const key = k.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k.label);
    if (out.length >= cap) break;
  }
  return out;
}

/** True if two skill strings refer to the same canonical skill. */
export function sameSkill(a: string, b: string): boolean {
  return normalizeSkill(a).toLowerCase() === normalizeSkill(b).toLowerCase();
}
