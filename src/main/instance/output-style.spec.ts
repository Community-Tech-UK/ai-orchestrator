import { describe, it, expect } from 'vitest';
import {
  applyOutputStyle,
  resolveOutputStyle,
  isOutputStyleName,
  isOutputStyleInjectableProvider,
  listOutputStyles,
  BUILT_IN_OUTPUT_STYLES,
} from './output-style';

describe('output-style', () => {
  it('default is a no-op (prompt unchanged)', () => {
    expect(applyOutputStyle('BASE', 'default')).toBe('BASE');
    expect(applyOutputStyle('BASE', undefined)).toBe('BASE');
    expect(applyOutputStyle('BASE', null)).toBe('BASE');
  });

  it('unknown styles fall back to default (no-op, no throw)', () => {
    expect(applyOutputStyle('BASE', 'nonsense')).toBe('BASE');
    expect(resolveOutputStyle('nonsense').name).toBe('default');
  });

  it('appends the directive for a real style', () => {
    const out = applyOutputStyle('BASE', 'concise');
    expect(out.startsWith('BASE\n\n---\n\n')).toBe(true);
    expect(out).toContain('Concise');
  });

  it('explanatory and learning each contribute a distinctive directive', () => {
    expect(applyOutputStyle('', 'explanatory')).toContain('Explanatory');
    expect(applyOutputStyle('', 'learning')).toContain('TODO(human)');
  });

  it('handles an empty base prompt (returns just the directive)', () => {
    const out = applyOutputStyle('', 'concise');
    expect(out).toBe(BUILT_IN_OUTPUT_STYLES.concise.directive);
    expect(out).not.toContain('---');
  });

  it('isOutputStyleName validates membership', () => {
    expect(isOutputStyleName('learning')).toBe(true);
    expect(isOutputStyleName('default')).toBe(true);
    expect(isOutputStyleName('bogus')).toBe(false);
    expect(isOutputStyleName(42)).toBe(false);
  });

  it('gates injectable providers (unknown → injectable)', () => {
    expect(isOutputStyleInjectableProvider('claude')).toBe(true);
    expect(isOutputStyleInjectableProvider('codex')).toBe(true);
    expect(isOutputStyleInjectableProvider(undefined)).toBe(true);
    expect(isOutputStyleInjectableProvider('ollama')).toBe(false);
  });

  it('lists all built-in styles', () => {
    const styles = listOutputStyles();
    expect(styles.map((s) => s.name).sort()).toEqual(['concise', 'default', 'explanatory', 'learning']);
  });
});
