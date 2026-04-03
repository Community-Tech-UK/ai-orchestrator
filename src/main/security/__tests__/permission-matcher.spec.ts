import { describe, it, expect } from 'vitest';
import {
  globToRegex,
  compileRules,
  type CompiledMatcher,
} from '../permission-manager';
import type { PermissionRule } from '../permission-manager';

function makeRule(pattern: string, id = 'r1'): PermissionRule {
  return {
    id,
    name: `rule-${id}`,
    scope: 'file_read',
    pattern,
    action: 'allow',
    priority: 0,
    source: 'default',
    enabled: true,
  };
}

describe('globToRegex()', () => {
  it('matches an exact filename', () => {
    const re = globToRegex('foo.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('bar.ts')).toBe(false);
  });

  it('* matches within a single path segment', () => {
    const re = globToRegex('src/*.ts');
    expect(re.test('src/index.ts')).toBe(true);
    expect(re.test('src/nested/index.ts')).toBe(false);
  });

  it('** matches across path separators', () => {
    const re = globToRegex('src/**/*.ts');
    expect(re.test('src/foo.ts')).toBe(true);
    expect(re.test('src/a/b/c/index.ts')).toBe(true);
    expect(re.test('lib/foo.ts')).toBe(false);
  });

  it('? matches exactly one non-separator character', () => {
    const re = globToRegex('fo?.ts');
    expect(re.test('foo.ts')).toBe(true);
    expect(re.test('fo.ts')).toBe(false);
    expect(re.test('fooo.ts')).toBe(false);
  });

  it('escapes regex special characters in literal parts', () => {
    const re = globToRegex('path/to/file.ts');
    // The dot in 'file.ts' should match only a literal dot
    expect(re.test('path/to/fileXts')).toBe(false);
    expect(re.test('path/to/file.ts')).toBe(true);
  });

  it('handles patterns with no wildcards', () => {
    const re = globToRegex('/usr/local/bin/node');
    expect(re.test('/usr/local/bin/node')).toBe(true);
    expect(re.test('/usr/local/bin/node2')).toBe(false);
  });
});

describe('compileRules()', () => {
  it('returns a CompiledMatcher with a ruleHash', () => {
    const matcher = compileRules([makeRule('src/*.ts')]);
    expect(typeof matcher.ruleHash).toBe('string');
    expect(matcher.ruleHash.length).toBeGreaterThan(0);
  });

  it('test() returns true when any rule pattern matches', () => {
    const matcher = compileRules([
      makeRule('src/*.ts', 'r1'),
      makeRule('lib/*.js', 'r2'),
    ]);
    expect(matcher.test('src/index.ts')).toBe(true);
    expect(matcher.test('lib/util.js')).toBe(true);
  });

  it('test() returns false when no pattern matches', () => {
    const matcher = compileRules([makeRule('src/*.ts')]);
    expect(matcher.test('test/index.spec.ts')).toBe(false);
  });

  it('same rules produce same ruleHash', () => {
    const rules = [makeRule('src/*.ts'), makeRule('lib/*.js', 'r2')];
    const m1 = compileRules(rules);
    const m2 = compileRules(rules);
    expect(m1.ruleHash).toBe(m2.ruleHash);
  });

  it('different rules produce different ruleHash', () => {
    const m1 = compileRules([makeRule('src/*.ts')]);
    const m2 = compileRules([makeRule('lib/*.ts')]);
    expect(m1.ruleHash).not.toBe(m2.ruleHash);
  });

  it('handles empty rule list', () => {
    const matcher = compileRules([]);
    expect(matcher.test('anything')).toBe(false);
    expect(typeof matcher.ruleHash).toBe('string');
  });

  it('only includes enabled rules', () => {
    const disabledRule: PermissionRule = { ...makeRule('src/*.ts'), enabled: false };
    const matcher = compileRules([disabledRule]);
    expect(matcher.test('src/index.ts')).toBe(false);
  });
});

// Validate the exported type is usable
const _typeCheck: CompiledMatcher = {
  test: (_input: string) => false,
  ruleHash: 'test',
};
void _typeCheck;
