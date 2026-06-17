import { describe, expect, it } from 'vitest';
import {
  createDefaultVerificationConfig,
  DEFAULT_VERIFICATION_MAX_DEBATE_ROUNDS,
} from './verification.types';

describe('verification.types', () => {
  it('defaults verification debate rounds to the low-cost two-round shape', () => {
    expect(DEFAULT_VERIFICATION_MAX_DEBATE_ROUNDS).toBe(2);
    expect(createDefaultVerificationConfig().maxDebateRounds).toBe(2);
  });
});
