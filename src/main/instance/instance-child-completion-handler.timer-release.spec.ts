/**
 * Plan 13c: "a held result released by the timer is delivered through
 * `deliverChildCompleted` and does not count a failure twice (assert
 * `consecutiveFailures` unchanged)".
 *
 * Runs the handler against the REAL OrchestrationHandler so the failure streak
 * is the real one. A held success is bookkept once, when its child exits
 * (a success resets the streak to 0). If the timer release bookkept it again,
 * it would reset a streak that a later, unrelated failure had raised, which is
 * what this test can see.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceChildCompletionHandler } from './instance-child-completion-handler';
import { OrchestrationHandler } from '../orchestration/orchestration-handler';
import { CHILD_BATCH_MAX_HOLD_MS } from '../orchestration/child-completion-batcher';
import { createInstance, type Instance } from '../../shared/types/instance.types';

vi.mock('../rlm/llm-service', () => ({ LLMService: { getInstance: () => ({ countTokens: (s: string) => s.length }) } }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));
vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    registerRedeliveryHandler: vi.fn(),
    admitAutomatedWrite: () => ({ kind: 'admitted', admissionId: 'inert' }),
    markDelivered: vi.fn(),
    markFailed: vi.fn(),
  }),
}));
vi.mock('../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

function streak(orchestration: OrchestrationHandler, parentId: string): number | undefined {
  return (Reflect.get(orchestration, 'consecutiveFailures') as Map<string, number>).get(parentId);
}

describe('held results released by the maximum-hold timer (real OrchestrationHandler)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('delivers through deliverChildCompleted and leaves consecutiveFailures unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(0);

    const make = (id: string, parentId: string | null): Instance => ({
      ...createInstance({ workingDirectory: '/tmp', provider: 'claude' }),
      id, parentId, displayName: id, status: 'idle', createdAt: 100, lastActivity: 100,
      outputBuffer: [{ id: `${id}-out`, timestamp: 100, type: 'assistant', content: `Result ${id}` }],
    });
    const parent = make('parent', null);
    const instances = new Map<string, Instance>([['parent', parent]]);
    const results = new Map<string, { success: boolean }>([
      ['x', { success: false }], ['a', { success: true }], ['b', { success: true }],
    ]);

    const orchestration = new OrchestrationHandler();
    orchestration.registerInstance('parent', '/tmp');
    orchestration.on('inject-response', (_id, _response, confirm) => confirm());
    const delivered = vi.spyOn(orchestration, 'deliverChildCompleted');
    const bookkeeping = vi.spyOn(orchestration, 'notifyChildTerminated');
    const synthesis = vi.spyOn(orchestration, 'notifyAllChildrenCompleted');

    const handler = new InstanceChildCompletionHandler({
      getInstance: (id) => instances.get(id),
      addToOutputBuffer: (target, message) => { target.outputBuffer.push(message); },
      publishOutput: () => undefined,
      terminateInstance: async (id) => { instances.delete(id); orchestration.unregisterInstance(id); },
      getOrchestrationHandler: () => orchestration,
      storage: {
        hasResult: () => true,
        storeFromOutputBuffer: async () => undefined,
        getChildSummary: async (childId) => ({
          resultId: childId, summary: `Result ${childId}`, conclusions: [], artifactCount: 0,
          success: results.get(childId)?.success ?? false,
        }),
      },
      taskManager: { getTaskByChildId: () => null, cleanupChildTasks: () => undefined },
    });

    try {
      // x is an older child; a and b are spawned together five minutes later.
      for (const [id, at] of [['x', 0], ['a', 300_000], ['b', 301_000]] as const) {
        vi.setSystemTime(at);
        instances.set(id, make(id, 'parent'));
        orchestration.notifyChildSpawned('parent', id, id.toUpperCase());
      }

      // a succeeds first: held, streak reset to 0 by its one bookkeeping call.
      await handler.handleChildExit('a', instances.get('a')!, 0);
      expect(delivered).not.toHaveBeenCalled();
      expect(streak(orchestration, 'parent')).toBe(0);

      // x (not in the burst) fails: sent now, streak is 1, a stays held.
      await handler.handleChildExit('x', instances.get('x')!, 1);
      expect(delivered).toHaveBeenCalledExactlyOnceWith('parent', 'x', expect.objectContaining({ success: false }));
      expect(streak(orchestration, 'parent')).toBe(1);
      expect(bookkeeping).toHaveBeenCalledTimes(2);

      // The hold times out: a is released one by one through deliverChildCompleted.
      await vi.advanceTimersByTimeAsync(CHILD_BATCH_MAX_HOLD_MS);

      expect(delivered).toHaveBeenCalledTimes(2);
      expect(delivered).toHaveBeenLastCalledWith('parent', 'a', expect.objectContaining({ name: 'a', success: true }));
      expect(bookkeeping).toHaveBeenCalledTimes(2);
      expect(streak(orchestration, 'parent')).toBe(1);
      expect(synthesis).not.toHaveBeenCalled();
    } finally {
      handler.dispose();
    }
  });
});
