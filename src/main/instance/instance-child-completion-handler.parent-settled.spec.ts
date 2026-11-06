/**
 * Plan 13c: "State for a batch is dropped when the batch completes". When the
 * parent's last running child exits, `handleChildExit` takes the
 * `remainingChildren === 0` path, which never calls `batcher.decide`, so the
 * only thing that closes the burst is `batcher.noteParentSettled(parentId)`.
 *
 * Observable effect pinned here (round 5, W15a): a child spawned later, inside
 * the 30 s spawn window of the settled burst's last spawn, must start its own
 * burst. If the burst were left open it would be added to the finished one, a
 * lone later child would end as a "final" batch with a synthesis message
 * instead of being sent at once, and the parent would be told "started together".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceChildCompletionHandler } from './instance-child-completion-handler';
import { CHILD_BATCH_SPAWN_WINDOW_MS } from '../orchestration/child-completion-batcher';
import type { Instance } from '../../shared/types/instance.types';

vi.mock('../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

function make(id: string, parentId: string | null): Instance {
  return {
    id,
    displayName: id,
    parentId,
    outputBuffer: [],
    createdAt: 0,
    status: 'idle',
    childrenIds: [],
    workingDirectory: '/repo',
  } as unknown as Instance;
}

describe('InstanceChildCompletionHandler: a settled parent closes its burst (plan 13c)', () => {
  let handler: InstanceChildCompletionHandler;
  let running: Set<string>;
  const completed: string[] = [];
  const orchestration = {
    notifyChildTerminated: vi.fn(),
    deliverChildCompleted: vi.fn(),
    getCompletedChildIds: vi.fn(),
    getActiveChildCount: vi.fn<() => number>(),
    notifyAllChildrenCompleted: vi.fn(),
  };
  const parent = make('parent', null);

  beforeEach(() => {
    vi.resetAllMocks();
    running = new Set<string>();
    completed.length = 0;
    orchestration.notifyChildTerminated.mockImplementation((_parentId: string, childId: string) => {
      running.delete(childId);
      completed.push(childId);
      return { remainingChildren: running.size };
    });
    orchestration.getActiveChildCount.mockImplementation(() => running.size);
    orchestration.getCompletedChildIds.mockImplementation(() => [...completed]);
    handler = new InstanceChildCompletionHandler({
      getInstance: (id) => (id === 'parent' ? parent : undefined),
      addToOutputBuffer: vi.fn(),
      publishOutput: vi.fn(),
      terminateInstance: vi.fn().mockResolvedValue(undefined),
      getOrchestrationHandler: () => orchestration,
      storage: {
        hasResult: () => true,
        storeFromOutputBuffer: vi.fn().mockResolvedValue(undefined),
        getChildSummary: async (childId: string) => ({
          resultId: childId, summary: `Result ${childId}`, success: true, conclusions: [], artifactCount: 0,
        }),
      },
      taskManager: { getTaskByChildId: () => null, cleanupChildTasks: vi.fn() },
    });
  });

  afterEach(() => { handler.dispose(); });

  async function exit(id: string): Promise<void> {
    await handler.handleChildExit(id, make(id, 'parent'), 0);
  }

  it('starts a new burst for a child spawned inside the spawn window after the parent settled', async () => {
    // First wave: a and b are spawned together; a is held, b ends the set (remaining 0).
    running = new Set(['a', 'b']);
    handler.noteSpawn('parent', 'a', 0);
    handler.noteSpawn('parent', 'b', 1_000);
    await exit('a');
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    await exit('b');
    expect(orchestration.notifyAllChildrenCompleted).toHaveBeenCalledTimes(1);
    expect(orchestration.notifyAllChildrenCompleted.mock.calls[0]![1]).toHaveLength(2);
    orchestration.notifyAllChildrenCompleted.mockClear();

    // Second wave, still inside the 30 s window of b's spawn: x is spawned, then a
    // long-running w more than 30 s after x, so w is not x's burst-mate.
    const xSpawnedAt = 1_000 + CHILD_BATCH_SPAWN_WINDOW_MS - 1_000;
    handler.noteSpawn('parent', 'x', xSpawnedAt);
    handler.noteSpawn('parent', 'w', xSpawnedAt + CHILD_BATCH_SPAWN_WINDOW_MS + 1);
    running = new Set(['x', 'w']);
    await exit('x');

    // x is alone in its own burst: sent at once, no "started together" synthesis.
    expect(orchestration.deliverChildCompleted).toHaveBeenCalledExactlyOnceWith(
      'parent', 'x', expect.objectContaining({ name: 'x', success: true }),
    );
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
  });
});
