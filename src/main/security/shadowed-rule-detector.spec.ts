import { describe, it, expect } from 'vitest';
import { detectShadowedRules, globSubsumes } from './shadowed-rule-detector';
import type { PermissionRule } from './permission-manager';

let seq = 0;
function rule(overrides: Partial<PermissionRule> & Pick<PermissionRule, 'scope' | 'pattern' | 'action' | 'priority' | 'source'>): PermissionRule {
  seq += 1;
  return {
    id: `rule-${seq}`,
    name: `rule-${seq}`,
    enabled: true,
    ...overrides,
  };
}

describe('globSubsumes', () => {
  it('is true for identical patterns', () => {
    expect(globSubsumes('src/**', 'src/**')).toBe(true);
    expect(globSubsumes('src/foo.ts', 'src/foo.ts')).toBe(true);
  });

  it('treats "**" as a universal pattern that subsumes anything', () => {
    expect(globSubsumes('**', 'src/foo.ts')).toBe(true);
    expect(globSubsumes('**', '/etc/passwd')).toBe(true);
    expect(globSubsumes('**', 'a/b/**')).toBe(true); // even a wildcard-bearing narrower pattern
  });

  it('normalizes a leading "./" before comparing, matching globMatch', () => {
    expect(globSubsumes('./**', 'src/foo.ts')).toBe(true);
  });

  it('subsumes a literal path under a directory-recursive prefix', () => {
    expect(globSubsumes('src/**', 'src/foo/bar.ts')).toBe(true);
    expect(globSubsumes('src/**', 'other/bar.ts')).toBe(false);
  });

  it('does not treat a same-prefix sibling directory as subsumed', () => {
    // "srcfoo/x" is not under "src/", even though it shares a text prefix.
    expect(globSubsumes('src/**', 'srcfoo/x')).toBe(false);
  });

  it('subsumes a literal segment matched by a single "*" within one path segment', () => {
    expect(globSubsumes('src/*.ts', 'src/foo.ts')).toBe(true);
    expect(globSubsumes('src/*.ts', 'src/nested/foo.ts')).toBe(false); // * does not cross "/"
  });

  it('subsumes a narrower recursive-directory pattern nested under a broader one', () => {
    expect(globSubsumes('foo/**', 'foo/bar/**')).toBe(true);
    expect(globSubsumes('foo/**', 'foobar/**')).toBe(false); // no "/" boundary — not actually nested
    expect(globSubsumes('foo/**', 'bar/**')).toBe(false);
  });

  it('is conservative when the relationship cannot be proven', () => {
    // Two single-segment wildcard patterns with no subset relationship provable
    // by this analysis.
    expect(globSubsumes('*.ts', '*.spec.ts')).toBe(false);
    expect(globSubsumes('a/*/c/**', 'a/b/c/**')).toBe(false); // wildcard inside the shared prefix
  });
});

describe('detectShadowedRules', () => {
  it('flags a narrower literal rule shadowed by an earlier broader glob rule (conflicting)', () => {
    const broadFirst = rule({ scope: 'file_read', pattern: './**', action: 'allow', priority: 1, source: 'system' });
    const narrowSecond = rule({
      scope: 'file_read',
      pattern: '/tmp/secret.txt',
      literal: true,
      action: 'deny',
      priority: 50,
      source: 'user',
    });
    const findings = detectShadowedRules([broadFirst, narrowSecond]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(narrowSecond);
    expect(findings[0].shadowedBy).toBe(broadFirst);
    expect(findings[0].kind).toBe('conflicting'); // allow vs deny — different outcome
  });

  it('does not flag a narrower rule that is evaluated before the broader one', () => {
    // Same two rules as above, but ordered the other way (narrow first) —
    // the narrow rule wins in real evaluation, so nothing is shadowed.
    const narrowFirst = rule({
      scope: 'file_read',
      pattern: '/tmp/secret.txt',
      literal: true,
      action: 'deny',
      priority: 5,
      source: 'user',
    });
    const broadSecond = rule({ scope: 'file_read', pattern: './**', action: 'allow', priority: 100, source: 'system' });
    expect(detectShadowedRules([narrowFirst, broadSecond])).toEqual([]);
  });

  it('flags a redundant duplicate rule with the same action as a "redundant" finding', () => {
    const first = rule({ scope: 'tool_use', pattern: 'Read|Glob', action: 'allow', priority: 10, source: 'system' });
    const dup = rule({ scope: 'tool_use', pattern: 'Read|Glob', action: 'allow', priority: 20, source: 'default' });
    const findings = detectShadowedRules([first, dup]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('redundant');
    expect(findings[0].shadowedBy).toBe(first);
  });

  it('respects cross-source precedence order as given, not source labels', () => {
    // Rules are compared strictly by list order (the caller has already
    // applied priority + source precedence), so a "system" rule that is
    // LATER in the list can still be shadowed by an earlier "user" rule.
    const userRule = rule({ scope: 'file_write', pattern: './**', action: 'deny', priority: 1, source: 'user' });
    const systemRule = rule({ scope: 'file_write', pattern: 'src/index.ts', literal: true, action: 'allow', priority: 1000, source: 'system' });
    const findings = detectShadowedRules([userRule, systemRule]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(systemRule);
    expect(findings[0].shadowedBy).toBe(userRule);
  });

  it('orders same-source rules by priority as given in the list', () => {
    const first = rule({ scope: 'file_read', pattern: '**/.ssh/id_*', action: 'deny', priority: 5, source: 'system' });
    const second = rule({ scope: 'file_read', pattern: '**/.ssh/id_rsa', literal: true, action: 'deny', priority: 6, source: 'system' });
    const findings = detectShadowedRules([first, second]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(second);
  });

  it('ignores disabled rules entirely — neither shadowing nor shadowed', () => {
    const disabledBroad = rule({ scope: 'file_read', pattern: './**', action: 'allow', priority: 1, source: 'system', enabled: false });
    const narrow = rule({ scope: 'file_read', pattern: 'src/foo.ts', literal: true, action: 'deny', priority: 50, source: 'user' });
    expect(detectShadowedRules([disabledBroad, narrow])).toEqual([]);
  });

  it('ignores expired rules', () => {
    const expiredBroad = rule({
      scope: 'file_read',
      pattern: './**',
      action: 'allow',
      priority: 1,
      source: 'session',
      expiresAt: Date.now() - 1000,
    });
    const narrow = rule({ scope: 'file_read', pattern: 'src/foo.ts', literal: true, action: 'deny', priority: 50, source: 'user' });
    expect(detectShadowedRules([expiredBroad, narrow])).toEqual([]);
  });

  it('does not treat conditions on the earlier rule as proof of shadowing', () => {
    // checkPermission skips a matched rule whose conditions fail and keeps
    // evaluating, so an earlier rule with conditions cannot guarantee a
    // later rule is unreachable.
    const conditioned = rule({
      scope: 'file_write',
      pattern: './**',
      action: 'allow',
      priority: 1,
      source: 'project',
      conditions: [{ type: 'working_directory', operator: 'starts_with', value: '/repo' }],
    });
    const narrow = rule({ scope: 'file_write', pattern: 'src/foo.ts', literal: true, action: 'deny', priority: 50, source: 'user' });
    expect(detectShadowedRules([conditioned, narrow])).toEqual([]);
  });

  it('flags a literal Bash command shadowed by an earlier regex rule', () => {
    const dangerous = rule({
      scope: 'bash_dangerous',
      pattern: 'rm -rf /|mkfs|dd if=',
      action: 'deny',
      priority: 1,
      source: 'system',
    });
    const literalDup = rule({
      scope: 'bash_dangerous',
      pattern: 'rm -rf /',
      literal: true,
      action: 'ask',
      priority: 50,
      source: 'user',
    });
    const findings = detectShadowedRules([dangerous, literalDup]);
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('conflicting'); // deny vs ask
  });

  it('does not flag two non-identical regex rules — unprovable by this analysis', () => {
    const a = rule({ scope: 'git_operation', pattern: 'git (status|log|diff)', action: 'allow', priority: 1, source: 'system' });
    const b = rule({ scope: 'git_operation', pattern: 'git (push|reset)', action: 'ask', priority: 2, source: 'system' });
    expect(detectShadowedRules([a, b])).toEqual([]);
  });

  it('does not flag rules in different scopes even when adjacent in the list', () => {
    const a = rule({ scope: 'file_read', pattern: './**', action: 'allow', priority: 1, source: 'system' });
    const b = rule({ scope: 'file_write', pattern: './**', action: 'allow', priority: 2, source: 'system' });
    expect(detectShadowedRules([a, b])).toEqual([]);
  });

  it('does not flag glob rules that are not provably a superset of each other', () => {
    const a = rule({ scope: 'file_read', pattern: '*.ts', action: 'allow', priority: 1, source: 'system' });
    const b = rule({ scope: 'file_read', pattern: '*.spec.ts', action: 'deny', priority: 2, source: 'system' });
    expect(detectShadowedRules([a, b])).toEqual([]);
  });

  it('flags a glob rule that is a provable superset of a later glob rule', () => {
    const wide = rule({ scope: 'file_write', pattern: 'src/**', action: 'allow', priority: 1, source: 'default' });
    const nested = rule({ scope: 'file_write', pattern: 'src/generated/**', action: 'deny', priority: 2, source: 'default' });
    const findings = detectShadowedRules([wide, nested]);
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe(nested);
    expect(findings[0].kind).toBe('conflicting');
  });

  it('explanation mentions both rules, their source/priority, and the action difference', () => {
    const wide = rule({ scope: 'file_write', pattern: './**', action: 'allow', priority: 1, source: 'system' });
    const narrow = rule({ scope: 'file_write', pattern: 'src/foo.ts', literal: true, action: 'deny', priority: 50, source: 'user' });
    const [finding] = detectShadowedRules([wide, narrow]);
    expect(finding.explanation).toContain('src/foo.ts');
    expect(finding.explanation).toContain('./**');
    expect(finding.explanation).toContain('allow');
    expect(finding.explanation).toContain('deny');
  });
});
