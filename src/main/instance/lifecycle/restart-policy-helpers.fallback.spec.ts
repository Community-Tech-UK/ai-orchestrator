/**
 * Fresh-fallback degradation preamble (resilient-threads Phase 3): every
 * fresh-fallback continuity message ends with an explicit notice that a new
 * session was started and background work was lost, with orchestration
 * children reconciled and listed. A broken orchestration registry must never
 * block recovery.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

const { mockSettings } = vi.hoisted(() => ({
  mockSettings: { sessionHandoffStateEnabled: false },
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => mockSettings }),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { RestartPolicyHelpers, type RestartPolicyDeps } from './restart-policy-helpers';

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

function makeHelpers(overrides: Partial<RestartPolicyDeps> = {}): RestartPolicyHelpers {
  return new RestartPolicyHelpers(
    {
      loadMessages: vi.fn().mockResolvedValue([]),
      archiveInstance: vi.fn(),
      resetBudgetTracker: vi.fn(),
      clearFirstMessageTracking: vi.fn(),
      ...overrides,
    },
    { getActiveMessages: (input) => input.outputBuffer },
  );
}

const buffer = [
  message('u1', 'user', 'build the widget'),
  message('a1', 'assistant', 'building the widget now'),
];

describe('RestartPolicyHelpers.buildFallbackHistory degradation preamble', () => {
  it('appends the degradation notice after the recovery message', async () => {
    const helpers = makeHelpers();

    const result = await helpers.buildFallbackHistory(makeInstance(buffer), 'resume-failed-fallback');

    expect(result).toContain('[SESSION RECOVERY');
    expect(result).toContain('[SESSION DEGRADATION NOTICE]');
    expect(result.indexOf('[SESSION DEGRADATION NOTICE]'))
      .toBeGreaterThan(result.indexOf('[SESSION RECOVERY'));
    expect(result.trimEnd().endsWith('[END SESSION DEGRADATION NOTICE]')).toBe(true);
  });

  it('reconciles orchestration children and lists live + dropped ones', async () => {
    const reconcile = vi.fn().mockReturnValue({
      activeChildren: [{ id: 'child-live', name: 'researcher', status: 'busy' }],
      droppedChildIds: ['child-dead'],
    });
    const helpers = makeHelpers({ reconcileOrchestrationChildren: reconcile });

    const result = await helpers.buildFallbackHistory(makeInstance(buffer), 'resume-failed-fallback');

    expect(reconcile).toHaveBeenCalledWith('inst-1');
    expect(result).toContain('- child-live (researcher, busy)');
    expect(result).toContain('lost in the restart (no longer running): child-dead');
  });

  it('still appends the notice on the replay-preamble fallback branch', async () => {
    // No conversational messages → buildFallbackHistoryMessage returns null
    // and the replay-continuity fallback path is used instead.
    const helpers = makeHelpers();

    const result = await helpers.buildFallbackHistory(makeInstance([]), 'resume-failed-fallback');

    expect(result).toContain('[SYSTEM CONTINUITY NOTICE]');
    expect(result).toContain('[SESSION DEGRADATION NOTICE]');
  });

  it('survives a throwing reconcile hook without losing the notice', async () => {
    const helpers = makeHelpers({
      reconcileOrchestrationChildren: vi.fn().mockImplementation(() => {
        throw new Error('registry unavailable');
      }),
    });

    const result = await helpers.buildFallbackHistory(makeInstance(buffer), 'resume-failed-fallback');

    expect(result).toContain('[SESSION DEGRADATION NOTICE]');
    expect(result).not.toContain('still alive and attached to you');
  });
});
