import { describe, expect, it } from 'vitest';
import { spendPurposeLabel } from './spend-purpose-labels';

describe('spendPurposeLabel', () => {
  it.each([
    ['plan-queue', 'Plan queue'], ['repo-job', 'Repo jobs'],
    ['remote-node', 'Remote machines'], ['quick-ask', 'Quick ask'],
    ['chat', 'Chat'], ['child', 'Child sessions'], ['helper', 'Helpers'],
    ['automation', 'Automations'], ['channel', 'Messages'],
  ])('labels %s as %s without changing the raw key', (key, label) => {
    expect(spendPurposeLabel(key)).toBe(label);
    expect(key).not.toBe(label);
  });

  it('gives future purpose keys a readable fallback', () => {
    expect(spendPurposeLabel('new-purpose')).toBe('New purpose');
  });
});
