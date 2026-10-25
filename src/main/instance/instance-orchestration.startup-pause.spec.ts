import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceOrchestrationManager } from './instance-orchestration';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { pauseConsults } from '../work-admission/consult-admission';

vi.mock('../learning/preference-store', () => ({ getPreferenceStore: () => ({ get: () => undefined }) }));
vi.mock('../learning/strategy-learner', () => ({ StrategyLearner: { getInstance: () => ({ getRecommendation: () => ({ confidence: 0 }) }) } }));

describe('helper creation during restart pause', () => {
  it.each([false, true])('waits for an admitted child then stops it, remote: %s', async remote => {
    WorkAdmission._resetForTesting();
    const parent = { id: 'parent', displayName: 'Parent', workingDirectory: '/repo', status: 'idle', parentId: null,
      childrenIds: [], depth: 0, outputBuffer: [] } as unknown as Instance;
    const instances = [parent];
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const creation = new Promise<void>(resolve => { release = resolve; });
    const terminateInstance = vi.fn(async (id: string) => { const index = instances.findIndex(instance => instance.id === id); if (index >= 0) instances.splice(index, 1); });
    const orchestration = new InstanceOrchestrationManager({ getInstance: id => instances.find(instance => instance.id === id),
      getInstanceCount: () => instances.length, getAdapter: () => undefined, sendInput: vi.fn(), recordTaskOutcome: vi.fn(), terminateInstance,
      createChildInstance: async () => { entered(); await creation; const child = { ...parent, id: 'late-child', parentId: parent.id } as Instance; instances.push(child); return child; },
    });
    vi.spyOn(orchestration, 'routeChildModel').mockReturnValue({ model: 'fast', complexity: 'simple', tier: 'fast', confidence: 1, reason: 'explicit' });
    orchestration.setupOrchestrationHandlers({ maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false, maxSpawnDepth: 0 }, vi.fn(), vi.fn());
    const spawn = orchestration.getOrchestrationHandler().listeners('spawn-child')[0] as (...args: unknown[]) => Promise<void>;
    const spawning = spawn('parent', { task: 'Implement the export guard', model: 'fast', agentId: 'worker', ...(remote ? { node: 'windows-pc' } : {}) });
    await started; getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedBeforeCreation = stopped;
    release(); await spawning; await pausing;
    expect(stoppedBeforeCreation).toBe(false);
    expect(instances).toEqual([parent]);
    expect(terminateInstance).toHaveBeenCalledWith('late-child', false);
    WorkAdmission._resetForTesting();
  });
});
