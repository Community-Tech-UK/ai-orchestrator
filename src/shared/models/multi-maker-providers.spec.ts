import { describe, expect, it } from 'vitest';
import { isMultiMakerProvider, sameProviderCheckerCanDiffer } from './multi-maker-providers';

describe('isMultiMakerProvider', () => {
  it.each(['copilot', 'antigravity', 'cursor'])('treats %s as serving several makers', (provider) => {
    expect(isMultiMakerProvider(provider)).toBe(true);
  });

  it.each(['claude', 'codex', 'grok', 'opencode'])('does not count %s (single maker, or no catalog to resolve a session model)', (provider) => {
    expect(isMultiMakerProvider(provider)).toBe(false);
  });
});

describe('sameProviderCheckerCanDiffer', () => {
  const differ = (a: string, b: string) => a.split('-')[0] !== b.split('-')[0];
  it('needs a checker model, and compares families when the workers\' model is named', () => {
    expect(sameProviderCheckerCanDiffer('copilot', undefined, 'gpt-5', differ)).toBe(false);
    expect(sameProviderCheckerCanDiffer('copilot', 'claude-x', 'gpt-5', differ)).toBe(true);
    expect(sameProviderCheckerCanDiffer('opencode', 'claude-x', 'gpt-5', differ)).toBe(true);
  });

  it('with the workers\' model unnamed, accepts only a catalog multi-maker CLI', () => {
    expect(sameProviderCheckerCanDiffer('copilot', 'claude-x', null, differ)).toBe(true);
    expect(sameProviderCheckerCanDiffer('opencode', 'claude-x', null, differ)).toBe(false);
    expect(sameProviderCheckerCanDiffer('codex', 'gpt-5', undefined, differ)).toBe(false);
  });
});
