import { describe, expect, it } from 'vitest';
import {
  CODEX_TURN_STOP_TOKENS,
  CODEX_TURN_WRAP_UP_TOKENS,
  CodexTurnTokenCeiling,
  codexCeilingGroup,
  resolveCodexTurnCeilingPolicy,
} from './codex-turn-token-ceiling';
import { CODEX_TURN_CEILING_MAX_TOKENS } from '../../../../shared/types/codex-turn-ceiling-settings.types';
import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../../shared/types/settings.types';
import { harnessStopNotice, isHarnessStopError, HarnessStopError, harnessStopDetailsOf, harnessStopEventDetails } from '../../../../shared/utils/harness-stop';

const M = 1_000_000;
const machine = resolveCodexTurnCeilingPolicy('plan-queue', DEFAULT_SETTINGS);
const chat = resolveCodexTurnCeilingPolicy('chat', DEFAULT_SETTINGS);

describe('Codex turn ceiling policy', () => {
  it.each(['loop', 'plan-queue', 'automation', 'review'] as const)('treats %s as Harness work that may be stopped', (kind) => {
    expect(codexCeilingGroup(kind)).toBe('harness');
    expect(resolveCodexTurnCeilingPolicy(kind, DEFAULT_SETTINGS)).toEqual({ group: 'harness', wrapUpAt: 150 * M, stopAt: 300 * M });
  });

  it.each(['chat', 'child', undefined] as const)('never stops %s by default (Decision 16a)', (kind) => {
    expect(resolveCodexTurnCeilingPolicy(kind, DEFAULT_SETTINGS)).toEqual({ group: 'chat', wrapUpAt: 150 * M, stopAt: 0 });
  });

  it('keeps chat and Harness thresholds independent', () => {
    const settings = { ...DEFAULT_SETTINGS, codexTurnCeilingChatsWrapUpTokens: 10 * M, codexTurnCeilingHarnessWorkStopTokens: 20 * M };
    expect(resolveCodexTurnCeilingPolicy('chat', settings)).toMatchObject({ wrapUpAt: 10 * M, stopAt: 0 });
    expect(resolveCodexTurnCeilingPolicy('loop', settings)).toMatchObject({ wrapUpAt: 150 * M, stopAt: 20 * M });
  });

  it('falls back to the built-in values for missing or malformed settings', () => {
    expect(resolveCodexTurnCeilingPolicy('plan-queue', undefined)).toMatchObject({ wrapUpAt: 150 * M, stopAt: 300 * M });
    expect(resolveCodexTurnCeilingPolicy('plan-queue', { codexTurnCeilingHarnessWorkStopTokens: -1, codexTurnCeilingHarnessWorkWrapUpTokens: Number.NaN }))
      .toMatchObject({ wrapUpAt: 150 * M, stopAt: 300 * M });
  });
});

describe('CodexTurnTokenCeiling', () => {
  const add = (ceiling: CodexTurnTokenCeiling, tokens: number, helper = false) => {
    ceiling.record(tokens, helper);
    return ceiling.evaluate();
  };

  it('hands out one wrap-up claim when the round crosses 150M, and none once it is delivered', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    expect(add(ceiling, 149 * M)).toEqual({ stop: false, wrapUp: null });
    const action = add(ceiling, 1 * M);
    expect(action.stop).toBe(false);
    expect(action.wrapUp).not.toBeNull();
    expect(ceiling.settleWrapUp(action.wrapUp!, true)).toBe(true);
    expect(add(ceiling, 10 * M)).toEqual({ stop: false, wrapUp: null });
    expect(ceiling.snapshot().wrapUpDelivered).toBe(true);
  });

  it('stops exactly once at 300M and never asks to wrap up afterwards', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    ceiling.settleWrapUp(add(ceiling, 160 * M).wrapUp!, true);
    expect(add(ceiling, 139 * M)).toEqual({ stop: false, wrapUp: null });
    expect(add(ceiling, 1 * M)).toEqual({ stop: true, wrapUp: null });
    expect(add(ceiling, 50 * M)).toEqual({ stop: false, wrapUp: null });
    expect(ceiling.snapshot().stopRequested).toBe(true);
  });

  it('skips the wrap-up when one update jumps straight past the stop point', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    expect(add(ceiling, 400 * M)).toEqual({ stop: true, wrapUp: null });
  });

  it('counts helper threads toward the same round', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    expect(add(ceiling, 100 * M)).toEqual({ stop: false, wrapUp: null });
    expect(add(ceiling, 49 * M, true)).toEqual({ stop: false, wrapUp: null });
    expect(add(ceiling, 1 * M, true).wrapUp).not.toBeNull();
    expect(ceiling.snapshot()).toMatchObject({ rootTokens: 100 * M, helperTokens: 50 * M, totalTokens: 150 * M });
    expect(ceiling.snapshot().helperShare).toBeCloseTo(1 / 3, 5);
  });

  it('never stops a chat but still asks it to wrap up', () => {
    const ceiling = new CodexTurnTokenCeiling(chat);
    ceiling.beginTurn('turn-1');
    const action = add(ceiling, 150 * M);
    expect(action.wrapUp).not.toBeNull();
    ceiling.settleWrapUp(action.wrapUp!, true);
    expect(add(ceiling, 2_000 * M)).toEqual({ stop: false, wrapUp: null });
  });

  it('allows one wrap-up request at a time, so samples during a request cannot use up the retries', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    const first = add(ceiling, 150 * M);
    expect(first.wrapUp).not.toBeNull();
    // Five more samples while the request is still running: no new claims, no attempts consumed.
    for (let sample = 0; sample < 5; sample += 1) expect(add(ceiling, 1)).toEqual({ stop: false, wrapUp: null });
    ceiling.settleWrapUp(first.wrapUp!, false);
    expect(add(ceiling, 1).wrapUp).not.toBeNull();
  });

  it('retries a failed wrap-up a bounded number of times', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    const outcomes: boolean[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const claim = add(ceiling, attempt === 0 ? 150 * M : 1).wrapUp;
      outcomes.push(claim !== null);
      if (claim !== null) ceiling.settleWrapUp(claim, false);
    }
    expect(outcomes).toEqual([true, true, true, false, false]);
  });

  it('ignores the answer to a wrap-up that was asked in an earlier round', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    const stale = add(ceiling, 150 * M).wrapUp!;
    ceiling.beginTurn('turn-2');
    expect(ceiling.settleWrapUp(stale, true)).toBe(false);
    expect(ceiling.snapshot().wrapUpDelivered).toBe(false);
    // The new round can ask for its own wrap-up even though the old request never settled.
    expect(add(ceiling, 150 * M).wrapUp).not.toBeNull();
  });

  it('counts without acting: recording alone never requests a stop or a wrap-up', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    ceiling.record(400 * M, false);
    expect(ceiling.snapshot()).toMatchObject({ totalTokens: 400 * M, stopRequested: false, wrapUpDelivered: false });
  });

  it('starts every round from zero', () => {
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    ceiling.record(310 * M, false);
    ceiling.beginTurn('turn-2');
    expect(ceiling.snapshot()).toMatchObject({ turnId: 'turn-2', totalTokens: 0, stopRequested: false, wrapUpDelivered: false });
    expect(add(ceiling, 299 * M).wrapUp).not.toBeNull();
  });

  it('ignores invalid token deltas and switches off at 0', () => {
    const off = new CodexTurnTokenCeiling({ group: 'harness', wrapUpAt: 0, stopAt: 0 });
    off.beginTurn('turn-1');
    expect(add(off, 5_000 * M)).toEqual({ stop: false, wrapUp: null });
    const ceiling = new CodexTurnTokenCeiling(machine);
    ceiling.beginTurn('turn-1');
    ceiling.record(Number.NaN, false);
    ceiling.record(-5, true);
    expect(ceiling.snapshot().totalTokens).toBe(0);
  });
});

describe('Codex ceiling settings stay in step with the code', () => {
  it('ships the documented thresholds and the bound repeated by the worker-closure settings modules', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({
      codexTurnCeilingHarnessWorkWrapUpTokens: CODEX_TURN_WRAP_UP_TOKENS,
      codexTurnCeilingHarnessWorkStopTokens: CODEX_TURN_STOP_TOKENS,
      codexTurnCeilingChatsWrapUpTokens: CODEX_TURN_WRAP_UP_TOKENS,
      codexTurnCeilingChatsStopTokens: 0,
    });
    for (const key of ['codexTurnCeilingHarnessWorkWrapUpTokens', 'codexTurnCeilingHarnessWorkStopTokens', 'codexTurnCeilingChatsWrapUpTokens', 'codexTurnCeilingChatsStopTokens'] as const) {
      expect(SETTINGS_METADATA.find((entry) => entry.key === key)).toMatchObject({ type: 'number', min: 0, max: CODEX_TURN_CEILING_MAX_TOKENS });
    }
  });
});

describe('Harness stop contract', () => {
  const details = { reason: 'turn-token-ceiling', tokens: 301_000_000, thresholdTokens: 300 * M } as const;

  it('words the notice the way the plan asks for it', () => {
    expect(harnessStopNotice(details)).toBe('Stopped by Harness: this turn passed 300M tokens.');
  });

  it('survives the trip onto a provider error event and back', () => {
    const error = new HarnessStopError(details);
    expect(isHarnessStopError(error)).toBe(true);
    expect(isHarnessStopError(new Error('Stopped by Harness'))).toBe(false);
    expect(harnessStopDetailsOf(harnessStopEventDetails(error))).toEqual(details);
    expect(harnessStopEventDetails(new Error('boom'))).toBeUndefined();
    expect(harnessStopDetailsOf({ stoppedByHarness: { reason: 'other', tokens: 1, thresholdTokens: 1 } })).toBeNull();
    expect(harnessStopDetailsOf(undefined)).toBeNull();
  });
});
