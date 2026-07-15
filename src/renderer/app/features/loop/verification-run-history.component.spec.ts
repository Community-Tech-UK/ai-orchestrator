import { describe, expect, it } from 'vitest';
import {
  verificationRunFreshness,
  verificationRunResultLabel,
} from './verification-run-history.component';

describe('verification-run history presentation', () => {
  it('marks a matching work-hash execution fresh and a different hash stale', () => {
    expect(verificationRunFreshness({ workHash: 'same' }, 'same')).toBe('fresh');
    expect(verificationRunFreshness({ workHash: 'old' }, 'current')).toBe('stale');
  });

  it('keeps freshness unknown when either work-state anchor is absent', () => {
    expect(verificationRunFreshness({ workHash: null }, 'current')).toBe('unknown');
    expect(verificationRunFreshness({ workHash: 'known' }, null)).toBe('unknown');
  });

  it('renders exit outcomes without treating a killed verification as a passing run', () => {
    expect(verificationRunResultLabel(0)).toBe('passed');
    expect(verificationRunResultLabel(1)).toBe('failed (exit 1)');
    expect(verificationRunResultLabel(null)).toBe('did not exit');
  });
});
