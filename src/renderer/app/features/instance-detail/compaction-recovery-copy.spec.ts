import { describe, expect, it } from 'vitest';
import {
  compactionRecoveryLabel,
  isCompactionRecoveryDisabled,
} from './compaction-recovery-copy';

describe('compaction-recovery-copy', () => {
  it('labels each recovery state', () => {
    expect(compactionRecoveryLabel('recovering')).toBe('Recovering');
    expect(compactionRecoveryLabel('queued')).toBe('Queued');
    expect(compactionRecoveryLabel('failed')).toBe('Retry recover');
    expect(compactionRecoveryLabel(undefined)).toBe('Recover context');
  });

  it('disables only in-flight recovery', () => {
    expect(isCompactionRecoveryDisabled('recovering')).toBe(true);
    expect(isCompactionRecoveryDisabled('queued')).toBe(true);
    expect(isCompactionRecoveryDisabled('failed')).toBe(false);
    expect(isCompactionRecoveryDisabled(undefined)).toBe(false);
  });
});
