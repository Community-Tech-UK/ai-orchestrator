import { describe, expect, it } from 'vitest';
import { shouldPreWarmReplacement } from './warm-start-policy';

describe('shouldPreWarmReplacement', () => {
  it('pre-warms after a fresh local spawn', () => {
    expect(shouldPreWarmReplacement(false, { type: 'local' })).toBe(true);
    expect(shouldPreWarmReplacement(undefined, { type: 'local' })).toBe(true);
  });

  it('treats a missing executionLocation (legacy instances) as local', () => {
    expect(shouldPreWarmReplacement(false, undefined)).toBe(true);
  });

  it('skips remote instances — their working directory does not exist locally', () => {
    expect(shouldPreWarmReplacement(false, { type: 'remote', nodeId: 'node-1' })).toBe(false);
    expect(shouldPreWarmReplacement(undefined, { type: 'remote', nodeId: 'node-1' })).toBe(false);
  });

  it('skips resume restores regardless of location', () => {
    expect(shouldPreWarmReplacement(true, { type: 'local' })).toBe(false);
    expect(shouldPreWarmReplacement(true, { type: 'remote', nodeId: 'node-1' })).toBe(false);
    expect(shouldPreWarmReplacement(true, undefined)).toBe(false);
  });
});
