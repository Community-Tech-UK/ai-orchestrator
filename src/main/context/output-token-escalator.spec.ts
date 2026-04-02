import { describe, it, expect, beforeEach } from 'vitest';
import { OutputTokenEscalator } from './output-token-escalator';

describe('OutputTokenEscalator', () => {
  let escalator: OutputTokenEscalator;

  beforeEach(() => {
    escalator = new OutputTokenEscalator({
      defaultTokens: 8192,
      maxTokens: 65536,
      maxRecoveryAttempts: 3,
    });
  });

  it('returns default tokens initially', () => {
    expect(escalator.getCurrentLimit()).toBe(8192);
  });

  it('escalates to max on first truncation', () => {
    const result = escalator.onTruncation();
    expect(result.shouldRetry).toBe(true);
    expect(result.newLimit).toBe(65536);
    expect(escalator.getCurrentLimit()).toBe(65536);
  });

  it('allows multi-turn recovery up to max attempts', () => {
    // First escalation
    escalator.onTruncation();

    // Multi-turn recovery attempts
    const r1 = escalator.onMultiTurnTruncation();
    expect(r1.shouldRetry).toBe(true);
    expect(r1.attemptNumber).toBe(1);

    const r2 = escalator.onMultiTurnTruncation();
    expect(r2.shouldRetry).toBe(true);
    expect(r2.attemptNumber).toBe(2);

    const r3 = escalator.onMultiTurnTruncation();
    expect(r3.shouldRetry).toBe(true);
    expect(r3.attemptNumber).toBe(3);

    const r4 = escalator.onMultiTurnTruncation();
    expect(r4.shouldRetry).toBe(false);
    expect(r4.exhausted).toBe(true);
  });

  it('resets recovery count on successful turn', () => {
    escalator.onTruncation();
    escalator.onMultiTurnTruncation();
    escalator.onMultiTurnTruncation();

    escalator.onSuccessfulTurn();
    expect(escalator.getRecoveryCount()).toBe(0);
  });

  it('does not escalate if already at max', () => {
    escalator.onTruncation();
    const secondResult = escalator.onTruncation();
    // Already at max — goes straight to multi-turn recovery
    expect(secondResult.alreadyEscalated).toBe(true);
  });
});
