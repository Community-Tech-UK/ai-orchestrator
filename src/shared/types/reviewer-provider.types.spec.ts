import { describe, expect, it } from 'vitest';
import {
  REMOTE_REVIEWER_PROVIDER_IDS,
  normalizeRemoteReviewerProvider,
} from './reviewer-provider.types';

describe('remote reviewer providers', () => {
  it('contains every canonical remote CLI reviewer once', () => {
    expect(REMOTE_REVIEWER_PROVIDER_IDS).toEqual([
      'claude', 'codex', 'antigravity', 'copilot', 'cursor', 'grok',
    ]);
  });

  it('normalizes legacy Gemini to Antigravity', () => {
    expect(normalizeRemoteReviewerProvider('gemini')).toBe('antigravity');
    expect(normalizeRemoteReviewerProvider(' GROK ')).toBe('grok');
  });
});
