/**
 * `spawn_child` asking for Gemini after Google retired the Gemini sign-in on this computer: the parent is told to use
 * another provider instead of getting a helper that is bound to fail. A worker computer keeps its own Gemini set-up.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Instance } from '../../../shared/types/instance.types';
import type { SpawnChildCommand } from '../../orchestration/orchestration-protocol.types';
import { GeminiRetirementRecord, getGeminiRetirementRecord } from '../../providers/gemini-retirement-record';
import { InstanceOrchestrationManager } from '../instance-orchestration';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../memory', () => ({ getUnifiedMemory: () => ({ recordTaskOutcome: vi.fn() }) }));
vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: { getInstance: () => ({ recordOutcome: vi.fn() }) },
}));
vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: { getInstance: () => ({ getRecommendation: vi.fn(() => null) }) },
}));
vi.mock('../../learning/preference-store', () => ({ getPreferenceStore: () => ({ get: vi.fn(() => undefined) }) }));

const SETTINGS = { maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false, maxSpawnDepth: 0 };
const LOCAL = { executionLocation: { type: 'local' } } as const;

function instance(fields: Partial<Instance>): Instance {
  return { status: 'idle', displayName: 'x', childrenIds: [], outputBuffer: [], workingDirectory: '/repo', depth: 0, ...fields } as unknown as Instance;
}

function setup(parent: Instance) {
  const createChildInstance = vi.fn().mockResolvedValue(instance({ id: 'child-1', parentId: parent.id, ...LOCAL }));
  const manager = new InstanceOrchestrationManager({
    getInstance: (id) => (id === parent.id ? parent : undefined),
    getInstanceCount: () => 1,
    createChildInstance,
    sendInput: vi.fn(),
    terminateInstance: vi.fn(),
    getAdapter: vi.fn(),
    recordTaskOutcome: vi.fn(),
  });
  manager.setupOrchestrationHandlers(SETTINGS, vi.fn(), vi.fn());
  const errors: string[] = [];
  vi.spyOn(manager.getOrchestrationHandler(), 'notifyError').mockImplementation((_id: string, message: string) => { errors.push(message); });
  const spawn = (command: Omit<SpawnChildCommand, 'action' | 'task'>): void => {
    manager.getOrchestrationHandler().emit('spawn-child', parent.id, { action: 'spawn_child', task: 'Review the plan', ...command });
  };
  return { createChildInstance, errors, spawn };
}

describe('spawn_child for Gemini once Google has retired the sign-in here', () => {
  beforeEach(() => GeminiRetirementRecord._resetForTesting());

  it('tells the parent to use Antigravity and creates nothing', async () => {
    getGeminiRetirementRecord().recordRetired();
    const { createChildInstance, errors, spawn } = setup(instance({ id: 'parent-1', provider: 'claude', ...LOCAL }));

    spawn({ provider: 'gemini' });
    await vi.waitFor(() => expect(errors).toHaveLength(1));

    expect(errors[0]).toMatch(/^Cannot spawn child: Google has retired Gemini/);
    expect(errors[0]).toContain('"antigravity"');
    expect(createChildInstance).not.toHaveBeenCalled();
  });

  it.each([
    ['Gemini has not been reported retired here', {}, false],
    ['another provider is asked for', { provider: 'antigravity' }, true],
    ['a worker computer is named', { provider: 'gemini', node: 'windows-pc' }, true],
  ] as const)('starts the helper when %s', async (_why, command, retired) => {
    if (retired) getGeminiRetirementRecord().recordRetired();
    const { createChildInstance, errors, spawn } = setup(instance({ id: 'parent-1', provider: 'claude', ...LOCAL }));

    spawn({ provider: 'gemini', ...command });
    await vi.waitFor(() => expect(createChildInstance).toHaveBeenCalledTimes(1));

    expect(errors.filter((message) => message.includes('Gemini'))).toEqual([]);
  });

  it('starts the helper when the parent runs on a worker computer, whose Gemini set-up is its own', async () => {
    getGeminiRetirementRecord().recordRetired();
    const { createChildInstance, spawn } = setup(instance({
      id: 'parent-1', provider: 'claude', executionLocation: { type: 'remote', nodeId: 'n1' },
    } as Partial<Instance>));

    spawn({ provider: 'gemini' });
    await vi.waitFor(() => expect(createChildInstance).toHaveBeenCalledTimes(1));
  });
});
