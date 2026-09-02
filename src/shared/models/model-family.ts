/**
 * Model *family* — which vendor actually trained the model behind an id.
 *
 * Why this exists
 * ---------------
 * Cross-model checking is only worth anything when the checker is a genuinely
 * different model from the implementer. The obvious axis — the provider/CLI —
 * is the wrong one, because a single provider can front several vendors:
 * GitHub Copilot serves Anthropic, OpenAI, Google, xAI, Moonshot and Microsoft
 * models from one seat. So "Copilot reviewed Copilot" can be a real second
 * opinion, while "the Claude CLI reviewed Copilot-running-claude-opus-5" is
 * self-review wearing a different badge.
 *
 * Family is that axis.
 *
 * Not a replacement for `modelProviderFamily()`
 * ---------------------------------------------
 * `shared/automations/automation-model-resolution.ts` has a similarly-named
 * helper that answers a different question — "which of OUR providers owns this
 * id" — and returns only `'claude' | 'codex' | undefined`. It is deliberately
 * conservative for provider routing and cannot express that `gpt-5.6-terra` and
 * `gpt-5.3-codex` are the same vendor, or classify gemini/grok/kimi/mai at all.
 * Both helpers are correct for their own job; do not merge them.
 *
 * Matching
 * --------
 * Prefix rules over a normalized id. Normalization lowercases, strips a
 * context-window suffix (`opus[1m]`), and folds whitespace/underscores to
 * hyphens so display-name forms classify too — the reviewer-model settings
 * genuinely hold values like `"Gemini 3.5 Flash (Medium)"`.
 *
 * `'auto'` is UNKNOWN on purpose. It means "let the CLI choose", so no family
 * can be claimed for it without guessing.
 */

export type ModelFamily =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'xai'
  | 'moonshot'
  | 'microsoft'
  | 'github'
  | 'unknown';

/** Bare Claude aliases that carry no `claude-` prefix. */
const ANTHROPIC_BARE_ALIASES: ReadonlySet<string> = new Set([
  'haiku',
  'sonnet',
  'opus',
]);

/**
 * Ordered prefix table. First match wins, so longer/more specific prefixes must
 * come before any prefix they extend.
 */
const FAMILY_PREFIXES: readonly (readonly [string, ModelFamily])[] = [
  ['claude-', 'anthropic'],
  ['gpt-', 'openai'],
  ['o1-', 'openai'],
  ['o3-', 'openai'],
  ['o4-', 'openai'],
  ['codex-', 'openai'],
  ['gemini-', 'google'],
  ['grok-', 'xai'],
  ['kimi-', 'moonshot'],
  ['mai-', 'microsoft'],
  ['raptor-', 'github'],
];

/**
 * Lowercase, drop a `[1m]`-style context suffix, and fold whitespace and
 * underscores to hyphens. Exported for tests and for callers that want to key a
 * cache on the same normalized form.
 */
export function normalizeModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/[\s_]+/g, '-')
    .trim();
}

/** Vendor behind a model id, or `'unknown'` when it cannot be identified. */
export function modelFamily(modelId: string | undefined | null): ModelFamily {
  if (typeof modelId !== 'string') return 'unknown';
  const normalized = normalizeModelId(modelId);
  if (!normalized) return 'unknown';

  // "Let the CLI decide" carries no family. Claiming one here would let an
  // `auto` checker be treated as diverse from anything, which is the exact
  // false confidence this module exists to prevent.
  if (normalized === 'auto' || normalized === 'default') return 'unknown';

  if (ANTHROPIC_BARE_ALIASES.has(normalized)) return 'anthropic';

  for (const [prefix, family] of FAMILY_PREFIXES) {
    if (normalized.startsWith(prefix)) return family;
  }

  return 'unknown';
}

/**
 * Do these two ids come from the same vendor?
 *
 * FALSE when either side is unknown. An unknown model must never be treated as
 * colliding: dropping or re-modelling a checker on a guess is worse than
 * letting a possibly-same-family checker run, and the whole policy is built on
 * only acting on positive identification.
 */
export function sameFamily(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const familyA = modelFamily(a);
  if (familyA === 'unknown') return false;
  const familyB = modelFamily(b);
  if (familyB === 'unknown') return false;
  return familyA === familyB;
}
