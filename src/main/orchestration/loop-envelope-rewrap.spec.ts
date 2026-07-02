import { describe, expect, it } from 'vitest';
import {
  buildEnvelopeRewrapCorrection,
  detectMalformedCompletionEnvelope,
} from './loop-envelope-rewrap';
import { buildCapWrapUpDirective } from './loop-coordinator-state-helpers';
import { isStickyWaitingForInput } from './loop-runtime-status';
import { createLoopPendingInput, type LoopState } from '../../shared/types/loop.types';

const DONE_REGEX = '<promise>\\s*DONE\\s*</promise>';

describe('detectMalformedCompletionEnvelope (D4)', () => {
  it('does not flag a well-formed marker', () => {
    expect(
      detectMalformedCompletionEnvelope('all done\n<promise>DONE</promise>', DONE_REGEX).malformed,
    ).toBe(false);
  });

  it('does not flag plain prose without a marker attempt', () => {
    expect(detectMalformedCompletionEnvelope('I promise this will be done soon', DONE_REGEX).malformed).toBe(false);
    expect(detectMalformedCompletionEnvelope('work continues', DONE_REGEX).malformed).toBe(false);
    expect(detectMalformedCompletionEnvelope('', DONE_REGEX).malformed).toBe(false);
  });

  it('flags an unclosed promise tag', () => {
    const result = detectMalformedCompletionEnvelope('finishing up\n<promise>DONE', DONE_REGEX);
    expect(result.malformed).toBe(true);
    expect(result.excerpt).toContain('<promise>');
  });

  it('flags a self-closing promise-done variant', () => {
    expect(detectMalformedCompletionEnvelope('<promise done/>', DONE_REGEX).malformed).toBe(true);
  });

  it('flags promise: DONE prose form', () => {
    expect(detectMalformedCompletionEnvelope('promise: DONE', DONE_REGEX).malformed).toBe(true);
  });

  it('flags common tag misspellings', () => {
    expect(detectMalformedCompletionEnvelope('<promsie>DONE</promsie>', DONE_REGEX).malformed).toBe(true);
  });

  it('degrades safely on an invalid configured regex', () => {
    expect(detectMalformedCompletionEnvelope('<promise>DONE', '[invalid').malformed).toBe(false);
  });
});

describe('buildEnvelopeRewrapCorrection (D4)', () => {
  it('cites the near-miss and the required form', () => {
    const message = buildEnvelopeRewrapCorrection('<promise>DONE');
    expect(message).toContain('<promise>DONE');
    expect(message).toContain('<promise>DONE</promise>');
    expect(message).toContain('malformed');
  });
});

describe('buildCapWrapUpDirective (D2 interim)', () => {
  it('names the cap and forbids new work', () => {
    const directive = buildCapWrapUpDirective('iterations', 'cap=iterations; after 50 iteration(s)');
    expect(directive).toContain('iterations cap');
    expect(directive).toContain('Do NOT start new work');
    expect(directive).toContain('hand-off');
  });
});

describe('isStickyWaitingForInput (A3)', () => {
  function state(overrides: Partial<LoopState>): Pick<
    LoopState,
    'status' | 'pausedForInput' | 'terminalIntentPending' | 'pendingInterventions'
  > {
    return {
      status: 'running',
      pausedForInput: undefined,
      terminalIntentPending: undefined,
      pendingInterventions: [],
      ...overrides,
    } as Pick<LoopState, 'status' | 'pausedForInput' | 'terminalIntentPending' | 'pendingInterventions'>;
  }

  it('is false for an ordinary running loop', () => {
    expect(isStickyWaitingForInput(state({}))).toBe(false);
  });

  it('is false for an ordinary (non-input) pause', () => {
    expect(isStickyWaitingForInput(state({ status: 'paused' }))).toBe(false);
  });

  it('is true when paused for input (BLOCKED/block intent)', () => {
    expect(isStickyWaitingForInput(state({ status: 'paused', pausedForInput: true }))).toBe(true);
  });

  it('is true in needs-human-arbitration', () => {
    expect(isStickyWaitingForInput(state({ status: 'needs-human-arbitration' }))).toBe(true);
  });

  it('is true while a block intent is pending', () => {
    expect(
      isStickyWaitingForInput(
        state({
          terminalIntentPending: {
            kind: 'block',
          } as LoopState['terminalIntentPending'],
        }),
      ),
    ).toBe(true);
  });

  it('is true while unconsumed human input is queued', () => {
    expect(
      isStickyWaitingForInput(
        state({ pendingInterventions: [createLoopPendingInput('try the other branch')] }),
      ),
    ).toBe(true);
  });

  it('is false for non-human queued inputs (automated nudges)', () => {
    expect(
      isStickyWaitingForInput(
        state({
          pendingInterventions: [createLoopPendingInput('nudge', { source: 'announce-then-halt' })],
        }),
      ),
    ).toBe(false);
  });
});
