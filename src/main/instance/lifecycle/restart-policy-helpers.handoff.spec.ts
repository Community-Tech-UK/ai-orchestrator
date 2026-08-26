/**
 * Hydration-ladder gating for the swap-time replay preamble (spec item 5):
 * OFF ⇒ byte-identical to the shared replay builder; ON ⇒ the maintained
 * handoff document is preferred, with fall-through when nothing was
 * maintained.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { buildReplayContinuityMessage as sharedBuilder } from '../../session/replay-continuity';
import { HandoffStateService, getHandoffStateService } from '../../session/handoff-state-service';

const { mockSettings, loggerStub } = vi.hoisted(() => ({
  mockSettings: { sessionHandoffStateEnabled: false },
  loggerStub: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => mockSettings }),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => loggerStub,
}));

import { RestartPolicyHelpers } from './restart-policy-helpers';

function message(id: string, type: 'user' | 'assistant', content: string): OutputMessage {
  return { id, type, content, timestamp: 1 } as OutputMessage;
}

function makeInstance(outputBuffer: OutputMessage[]): Instance {
  return {
    id: 'inst-1',
    outputBuffer,
    workingDirectory: '/repo',
    provider: 'claude',
    currentModel: 'sonnet',
  } as unknown as Instance;
}

function makeHelpers(): RestartPolicyHelpers {
  return new RestartPolicyHelpers(
    {
      loadMessages: vi.fn().mockResolvedValue([]),
      archiveInstance: vi.fn(),
      resetBudgetTracker: vi.fn(),
      clearFirstMessageTracking: vi.fn(),
    },
    { getActiveMessages: (input) => input.outputBuffer },
  );
}

describe('RestartPolicyHelpers replay-preamble hydration gating', () => {
  const buffer = [
    message('u1', 'user', 'build the widget'),
    message('a1', 'assistant', 'building the widget now'),
  ];

  beforeEach(() => {
    HandoffStateService._resetForTesting();
    mockSettings.sessionHandoffStateEnabled = false;
    loggerStub.debug.mockClear();
  });

  it('OFF: output is byte-identical to the shared replay builder', () => {
    const helpers = makeHelpers();
    const instance = makeInstance(buffer);
    getHandoffStateService().noteTurnCompleted(instance); // even with state maintained

    const result = helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(result).toBe(sharedBuilder(buffer, { reason: 'provider-change' }));
    expect(result).not.toContain('maintained handoff document');
  });

  it('ON with maintained state: returns the handoff document', () => {
    mockSettings.sessionHandoffStateEnabled = true;
    const helpers = makeHelpers();
    const instance = makeInstance(buffer);
    getHandoffStateService().noteTurnCompleted(instance);

    const result = helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(result).toContain('maintained handoff document (provider-change)');
    expect(result).toContain('Human: build the widget');
  });

  it('ON without maintained state: falls through to the replay preamble', () => {
    mockSettings.sessionHandoffStateEnabled = true;
    const helpers = makeHelpers();
    const instance = makeInstance(buffer); // no noteTurnCompleted

    const result = helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(result).toBe(sharedBuilder(buffer, { reason: 'provider-change' }));
  });
});

describe('RestartPolicyHelpers rung-choice observability (livetest instrumentation)', () => {
  // Fixed 2026-08-12: the continuity block is delivered straight into
  // adapter.sendInput and was never logged, so livetest checks for this
  // feature had to guess from a model's own answers instead of asserting
  // directly. See docs/superpowers/plans/2026-07-17-rolling-handoff-state-plan_livetest.md.
  const buffer = [
    message('u1', 'user', 'build the widget'),
    message('a1', 'assistant', 'building the widget now'),
  ];

  beforeEach(() => {
    HandoffStateService._resetForTesting();
    mockSettings.sessionHandoffStateEnabled = false;
    loggerStub.debug.mockClear();
  });

  it('logs the replay-preamble rung with content-free metadata when OFF', () => {
    const helpers = makeHelpers();
    const instance = makeInstance(buffer);

    const result = helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(loggerStub.debug).toHaveBeenCalledWith('Continuity rung selected', expect.objectContaining({
      instanceId: 'inst-1',
      reason: 'provider-change',
      rung: 'replay-preamble',
      documentChars: result.length,
      containsRedactionMarker: false,
    }));
    // Content-free by default: the rendered document body is not logged
    // unless AIO_HANDOFF_STATE_DIAGNOSTICS=1 is set.
    const loggedPayload = loggerStub.debug.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(loggedPayload['document']).toBeUndefined();
  });

  it('logs the maintained-handoff rung when ON with maintained state', () => {
    mockSettings.sessionHandoffStateEnabled = true;
    const helpers = makeHelpers();
    const instance = makeInstance(buffer);
    getHandoffStateService().noteTurnCompleted(instance);

    const result = helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(loggerStub.debug).toHaveBeenCalledWith('Continuity rung selected', expect.objectContaining({
      instanceId: 'inst-1',
      reason: 'provider-change',
      rung: 'maintained-handoff',
      documentChars: result.length,
    }));
  });

  it('reports a redaction marker hit when the document contains one', () => {
    mockSettings.sessionHandoffStateEnabled = true;
    const helpers = makeHelpers();
    const secretBuffer = [
      message('u1', 'user', 'here is a token sk-ant-FAKEFAKEFAKEFAKEFAKE for testing'),
      message('a1', 'assistant', 'noted'),
    ];
    const instance = makeInstance(secretBuffer);
    getHandoffStateService().noteTurnCompleted(instance);

    helpers.buildReplayContinuityMessage(instance, 'provider-change');

    expect(loggerStub.debug).toHaveBeenCalledWith('Continuity rung selected', expect.objectContaining({
      rung: 'maintained-handoff',
      containsRedactionMarker: true,
    }));
  });
});

describe('RestartPolicyHelpers original-request retention', () => {
  const opening = message('u0', 'user', 'Migrate the billing service off the legacy gateway.');
  /** The buffer after a trim: the opening prompt is gone from it. */
  const trimmedBuffer = [
    message('u9', 'user', 'carry on'),
    message('a9', 'assistant', 'carrying on'),
  ];

  function makeTrimmedInstance(): Instance {
    return { ...makeInstance(trimmedBuffer), retainedPrompts: [opening] } as Instance;
  }

  beforeEach(() => {
    HandoffStateService._resetForTesting();
    mockSettings.sessionHandoffStateEnabled = false;
  });

  it('replay rung: restores the evicted opening prompt into the preamble', () => {
    const instance = makeTrimmedInstance();

    const result = makeHelpers().buildReplayContinuityMessage(instance, 'provider-change');

    expect(result).toContain('Original request:');
    expect(result).toContain('Migrate the billing service off the legacy gateway.');
  });

  it('handoff rung: anchors the evicted opening prompt in the document', () => {
    mockSettings.sessionHandoffStateEnabled = true;
    const instance = makeTrimmedInstance();
    getHandoffStateService().noteTurnCompleted(instance);

    const result = makeHelpers().buildReplayContinuityMessage(instance, 'provider-change');

    expect(result).toContain('maintained handoff document');
    expect(result).toContain('Original request:');
    expect(result).toContain('Migrate the billing service off the legacy gateway.');
  });

  it('does not duplicate a retained prompt the buffer still holds', () => {
    const instance = { ...makeInstance([opening, ...trimmedBuffer]), retainedPrompts: [opening] } as Instance;

    const result = makeHelpers().buildReplayContinuityMessage(instance, 'provider-change');

    const occurrences = result.split('Migrate the billing service off the legacy gateway.').length - 1;
    // Once as the anchor, once in the transcript window — not three times.
    expect(occurrences).toBe(2);
  });
});
