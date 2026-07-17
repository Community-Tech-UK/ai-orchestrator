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

const { mockSettings } = vi.hoisted(() => ({
  mockSettings: { sessionHandoffStateEnabled: false },
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => mockSettings }),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
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
