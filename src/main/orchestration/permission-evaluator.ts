/**
 * Permission evaluator — wildcard-ruleset engine.
 *
 * Replaces the 254-line bespoke `role-capability-policy.ts` logic for per-call
 * rule evaluation with a 12-line `findLast` evaluator, matching the pattern
 * from opencode:src/permission/evaluate.ts (claude3.md §2).
 *
 * The key insight: flatten multiple rulesets (project, agent, session) and use
 * `findLast` so the most-specific matching rule wins.  A wildcard pattern of
 * "*" is the catch-all default.
 *
 * Rule priority (lowest → highest):
 *   1. Default built-in rules
 *   2. Project-level rules (from settings)
 *   3. Agent-level rules (from the role/capability profile)
 *   4. Session-level rules (from the current session override)
 *
 * Wildcard syntax: `*` matches any substring; `**` is identical (we don't
 * need recursive glob here, just a simple substring check).
 */

export type PermissionAction = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  /** Tool or operation permission key, e.g. "write", "network", "bash:*" */
  permission: string;
  /** Target pattern, e.g. a file path glob or "*" to match anything */
  pattern: string;
  action: PermissionAction;
}

/** Matches a concrete value against a wildcard rule pattern. */
function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '**') return true;
  if (!pattern.includes('*')) return value === pattern;
  // Convert simple glob to regex: escape everything then replace \* with .*
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Evaluate a permission check against an ordered list of rulesets.
 *
 * @param permission - The permission key being checked (e.g. "write", "bash")
 * @param pattern    - The specific target (e.g. a file path or "*")
 * @param rulesets   - Ordered from least-specific to most-specific; later rules win
 * @returns The winning rule, or a default `ask` rule if nothing matched
 */
export function evaluate(
  permission: string,
  pattern: string,
  ...rulesets: PermissionRule[][]
): PermissionRule {
  const rules = rulesets.flat();
  // findLast is ES2023; use a manual reverse scan for TS < ES2023 targets.
  let match: PermissionRule | undefined;
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern)) {
      match = rule;
      break;
    }
  }
  return match ?? { action: 'ask', permission, pattern: '*' };
}

/**
 * Convenience: check whether a permission is allowed given a set of rulesets.
 * Returns true for 'allow', false for 'deny', throws for 'ask' if strict.
 */
export function isAllowed(
  permission: string,
  pattern: string,
  rulesets: PermissionRule[][],
): boolean {
  const result = evaluate(permission, pattern, ...rulesets);
  return result.action === 'allow';
}

/**
 * Build a write-deny ruleset — used by Plan Mode and subagent derivation to
 * inject a blanket write-deny rule that overrides any project-level allow.
 */
export function writeDenyRuleset(): PermissionRule[] {
  return [{ permission: 'write', pattern: '*', action: 'deny' }];
}

/**
 * Build a read-only ruleset: deny write + deny network.
 * Suitable for debate reviewer agents that should only analyse, not modify.
 */
export function readOnlyRuleset(): PermissionRule[] {
  return [
    { permission: 'write', pattern: '*', action: 'deny' },
    { permission: 'network', pattern: '*', action: 'deny' },
  ];
}
