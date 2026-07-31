/**
 * Shadowed Permission Rule Detector
 *
 * Static lint over an already-ordered list of permission rules (as produced
 * by PermissionManager for a single scope, in the exact order checkPermission
 * would evaluate them). Reports rules that can never fire because an earlier
 * rule in that list is provably guaranteed to match first — i.e. every
 * resource the later rule would match, the earlier rule also matches.
 *
 * This module owns pattern-matching semantics only (glob/regex replicas of
 * PermissionManager's own matchers, plus a superset test for globs). It does
 * NOT know about rule-source precedence or priority ordering — callers must
 * pass in the list already ordered, so the two concerns never drift apart.
 *
 * Deliberately conservative: every case below is a provable subset/superset
 * relationship, never a heuristic guess. When a relationship cannot be proven
 * with the checks implemented here, the rule is left unflagged.
 */

import type { PermissionRule, PermissionScope } from './permission-manager';

/** Every permission scope, used by analyzeShadowedRules when no scope filter is given. */
export const ALL_PERMISSION_SCOPES: PermissionScope[] = [
  'file_read',
  'file_write',
  'file_delete',
  'directory_read',
  'directory_create',
  'directory_delete',
  'bash_execute',
  'bash_dangerous',
  'tool_use',
  'network_access',
  'subprocess_spawn',
  'environment_access',
  'secret_access',
  'git_operation',
  'external_service',
];

export type ShadowKind = 'redundant' | 'conflicting';

export interface ShadowedRuleFinding {
  /** The rule that can never fire. */
  rule: PermissionRule;
  /** The earlier rule that always matches first, making `rule` unreachable. */
  shadowedBy: PermissionRule;
  /**
   * 'redundant' — the shadowing rule decides the same action, so the dead
   * rule was merely a no-op duplicate.
   * 'conflicting' — the shadowing rule decides a DIFFERENT action, so the
   * dead rule would have produced a different outcome had it ever run.
   */
  kind: ShadowKind;
  /** Plain-language explanation for display in the settings UI. */
  explanation: string;
}

type EffectiveKind = 'literal' | 'glob' | 'regex' | 'contains';

const GLOB_SCOPE_PREFIXES = ['file_', 'directory_'];
const REGEX_SCOPES = new Set(['tool_use', 'bash_execute', 'bash_dangerous', 'git_operation']);
const GLOB_METACHARS = /[*?]/;

/**
 * Which matching algorithm PermissionManager.ruleMatches would use for this
 * rule. Mirrors permission-manager.ts `ruleMatches` (~938-980) exactly:
 * `literal` bypasses scope entirely; otherwise file/directory scopes use
 * glob, the four regex scopes use RegExp, everything else falls back to
 * exact-or-substring ("contains").
 */
function effectiveKind(rule: PermissionRule): EffectiveKind {
  if (rule.literal) return 'literal';
  if (GLOB_SCOPE_PREFIXES.some((prefix) => rule.scope.startsWith(prefix))) return 'glob';
  if (REGEX_SCOPES.has(rule.scope)) return 'regex';
  return 'contains';
}

/** Strip the normalization permission-manager's globMatch applies before conversion. */
function normalizeGlobForCompare(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/');
  if (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Replica of PermissionManager.globMatch (permission-manager.ts ~982-1011).
 * Kept in lockstep intentionally — if that algorithm changes, this one must
 * too, or "provable" claims here stop being provable. Covered by tests that
 * exercise the same glob syntax (`*`, `**`, `?`).
 */
function globMatchForAnalysis(pattern: string, filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const normalizedPattern = normalizeGlobForCompare(pattern);

  const regexPattern = normalizedPattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*')
    .replace(/\?/g, '.');

  try {
    return new RegExp(`^${regexPattern}$`).test(normalizedPath);
  } catch {
    return false;
  }
}

/**
 * Replica of the regex branch of PermissionManager.ruleMatches
 * (permission-manager.ts ~957-976): case-insensitive RegExp test, falling
 * back to substring containment if the pattern isn't valid regex.
 */
function regexTestForAnalysis(pattern: string, resource: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(resource);
  } catch {
    return resource.includes(pattern);
  }
}

function hasGlobMetachars(pattern: string): boolean {
  return GLOB_METACHARS.test(pattern);
}

/**
 * True when every resource `narrowerPattern` (as a glob) could ever match is
 * also matched by `broaderPattern` (as a glob) — i.e. `broaderPattern` is a
 * provable superset. Conservative by construction:
 *
 * - Identical patterns are trivially a superset of themselves.
 * - `broaderPattern === '**'` matches literally everything (permission-manager
 *   converts `**` to `.*`, unanchored other than start/end), so it subsumes
 *   any narrower pattern.
 * - If `narrowerPattern` contains no glob metacharacters (`*`, `?`), it can
 *   only ever match its own literal text — so the question reduces exactly to
 *   "does globMatch(broaderPattern, narrowerPattern-as-a-path) return true?".
 *   This single reduction also covers the "single `*` within one segment vs a
 *   literal segment" case (e.g. `src/*.ts` vs `src/foo.ts`) and the
 *   "broader is `dir/**`, narrower is a literal path under `dir/`" case.
 * - If both patterns contain wildcards, the only relationship this function
 *   will prove is a recursive-directory prefix: `broaderPattern` ends in
 *   `/**` and `narrowerPattern`'s literal (metacharacter-free) directory
 *   prefix places it entirely inside that directory, e.g. `foo/**` subsumes
 *   `foo/bar/**`. Anything else (e.g. two disjoint wildcard patterns) is left
 *   unflagged — not provably safe with this level of analysis.
 */
export function globSubsumes(broaderPattern: string, narrowerPattern: string): boolean {
  const broader = normalizeGlobForCompare(broaderPattern);
  const narrower = normalizeGlobForCompare(narrowerPattern);

  if (broader === narrower) return true;
  if (broader === '**') return true;

  if (!hasGlobMetachars(narrower)) {
    return globMatchForAnalysis(broader, narrower);
  }

  if (broader.endsWith('/**')) {
    const prefix = broader.slice(0, -3);
    if (prefix.length > 0 && !hasGlobMetachars(prefix) && narrower.startsWith(`${prefix}/`)) {
      return true;
    }
  }

  return false;
}

/**
 * True when `earlier` is provably guaranteed to match every resource `later`
 * would match. `earlier` and `later` must share a scope (callers only ever
 * pass same-scope rules — see detectShadowedRules).
 */
function rulesSubsume(earlier: PermissionRule, later: PermissionRule): boolean {
  const earlierKind = effectiveKind(earlier);
  const laterKind = effectiveKind(later);

  // Byte-identical pattern + identical matching algorithm ⇒ identical match
  // set, regardless of which kind of matcher it is.
  if (earlier.pattern === later.pattern && earlierKind === laterKind) {
    return true;
  }

  if (laterKind === 'literal') {
    // A literal pattern matches exactly one resource string (itself), so we
    // can test it directly against an earlier glob/regex matcher.
    if (earlierKind === 'glob') {
      return globMatchForAnalysis(earlier.pattern, later.pattern);
    }
    if (earlierKind === 'regex') {
      return regexTestForAnalysis(earlier.pattern, later.pattern);
    }
    return false;
  }

  if (laterKind === 'glob' && earlierKind === 'glob') {
    return globSubsumes(earlier.pattern, later.pattern);
  }

  // regex-vs-regex and contains-vs-contains (non-identical) relationships
  // are not provable with this level of analysis — leave unflagged.
  return false;
}

function describeRule(rule: PermissionRule): string {
  return `"${rule.name}" (${rule.source}, priority ${rule.priority}, pattern "${rule.pattern}")`;
}

function buildExplanation(earlier: PermissionRule, later: PermissionRule): string {
  const base =
    `${describeRule(later)} can never fire: ${describeRule(earlier)} is evaluated first ` +
    `and matches every resource ${describeRule(later)} would match`;
  if (earlier.action === later.action) {
    return `${base}, and decides the same action (${earlier.action}), so it is a redundant duplicate.`;
  }
  return `${base}, but decides "${earlier.action}" instead of "${later.action}" — the later rule's action would never be applied.`;
}

/**
 * Find rules in `orderedRules` that can never fire because an earlier rule
 * in the same list is provably guaranteed to match first.
 *
 * `orderedRules` MUST already be in evaluation order for a single scope —
 * i.e. exactly what PermissionManager.checkPermission would iterate for a
 * request of that scope (source precedence + priority already applied). This
 * function does not know about, and must never duplicate, that ordering.
 *
 * Disabled rules and expired rules are ignored entirely (they never fire in
 * checkPermission either, so they can neither shadow nor be shadowed). A
 * candidate earlier rule with `conditions` is never used to prove shadowing:
 * checkPermission skips a matched rule whose conditions don't hold and keeps
 * evaluating later rules, so a conditioned earlier rule does not guarantee
 * later rules are unreachable.
 */
export function detectShadowedRules(orderedRules: PermissionRule[]): ShadowedRuleFinding[] {
  const now = Date.now();
  const eligible = orderedRules.filter(
    (rule) => rule.enabled && (!rule.expiresAt || rule.expiresAt > now),
  );

  const findings: ShadowedRuleFinding[] = [];

  for (let i = 1; i < eligible.length; i++) {
    const rule = eligible[i];
    for (let j = 0; j < i; j++) {
      const earlier = eligible[j];
      if (earlier.scope !== rule.scope) continue; // defensive: callers pass single-scope lists
      if (earlier.conditions && earlier.conditions.length > 0) continue;

      if (rulesSubsume(earlier, rule)) {
        findings.push({
          rule,
          shadowedBy: earlier,
          kind: earlier.action === rule.action ? 'redundant' : 'conflicting',
          explanation: buildExplanation(earlier, rule),
        });
        break;
      }
    }
  }

  return findings;
}
