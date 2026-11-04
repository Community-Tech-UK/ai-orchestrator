import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceChildCompletionHandler } from './instance-child-completion-handler';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function message(
  type: OutputMessage['type'],
  content: string,
  metadata?: Record<string, unknown>,
): OutputMessage {
  return {
    id: `${type}-${content.length}-${Date.now()}`,
    timestamp: Date.now(),
    type,
    content,
    ...(metadata ? { metadata } : {}),
  };
}

function instance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'child-1',
    displayName: 'Child',
    parentId: 'parent-1',
    outputBuffer: [],
    createdAt: Date.now(),
    status: 'idle',
    childrenIds: [],
    workingDirectory: '/repo',
    ...overrides,
  } as Instance;
}

describe('InstanceChildCompletionHandler', () => {
  const storage = {
    hasResult: vi.fn(),
    storeFromOutputBuffer: vi.fn(),
    getChildSummary: vi.fn(),
  };
  const taskManager = {
    getTaskByChildId: vi.fn(),
    cleanupChildTasks: vi.fn(),
  };
  const orchestration = {
    notifyChildTerminated: vi.fn(),
    getCompletedChildIds: vi.fn(),
    notifyAllChildrenCompleted: vi.fn(),
  };
  const terminateInstance = vi.fn();

  function createHandler(parent = instance({ id: 'parent-1', parentId: null })): InstanceChildCompletionHandler {
    return new InstanceChildCompletionHandler({
      getInstance: (id) => (id === parent.id ? parent : undefined),
      addToOutputBuffer: vi.fn(),
      publishOutput: vi.fn(),
      terminateInstance,
      getOrchestrationHandler: () => orchestration,
      storage,
      taskManager,
      buildDiagnosticBundle: vi.fn(),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storage.hasResult.mockReturnValue(false);
    storage.storeFromOutputBuffer.mockResolvedValue(undefined);
    storage.getChildSummary.mockResolvedValue(null);
    taskManager.getTaskByChildId.mockReturnValue(null);
    orchestration.notifyChildTerminated.mockReturnValue({ remainingChildren: 1 });
    orchestration.getCompletedChildIds.mockReturnValue([]);
    terminateInstance.mockResolvedValue(undefined);
  });

  it('skips seeded parent messages and stores a no-output summary instead of echoing them back', async () => {
    const child = instance({
      outputBuffer: [
        message('assistant', 'PARENT_PRIOR_TEXT_THAT_MUST_NOT_ECHO_BACK', {
          seededFromParent: true,
        }),
      ],
    });
    const handler = createHandler();

    await handler.handleChildExit(child.id, child, 0);

    const [, parentId, , storedSummary, storedSuccess] = storage.storeFromOutputBuffer.mock.calls[0];
    expect(parentId).toBe('parent-1');
    expect(storedSummary).toBe('Child exited without producing any output.');
    expect(storedSummary).not.toContain('PARENT_PRIOR_TEXT_THAT_MUST_NOT_ECHO_BACK');
    expect(storedSuccess).toBe(false);
  });

  it('captures the child own last assistant message when one exists', async () => {
    const child = instance({
      outputBuffer: [
        message('assistant', 'seeded parent', { seededFromParent: true }),
        message('assistant', 'CHILD_ACTUAL_REPORTED_RESULT'),
      ],
    });
    const handler = createHandler();

    await handler.handleChildExit(child.id, child, 0);

    const [, , , storedSummary, storedSuccess] = storage.storeFromOutputBuffer.mock.calls[0];
    expect(storedSummary).toBe('CHILD_ACTUAL_REPORTED_RESULT');
    expect(storedSuccess).toBe(true);
  });

  it('leaves an engine-owned child alone: no report to the parent and no close', async () => {
    const child = instance({
      metadata: { planQueueRunId: 'run-1', planQueueItemId: 'item-1', planQueueRole: 'worker' },
      outputBuffer: [message('assistant', 'Round finished.')],
    });
    orchestration.notifyChildTerminated.mockReturnValue({ remainingChildren: 0 });
    orchestration.getCompletedChildIds.mockReturnValue([child.id]);
    const handler = createHandler();

    await handler.handleChildExit(child.id, child, 0);

    expect(storage.storeFromOutputBuffer).not.toHaveBeenCalled();
    expect(orchestration.notifyChildTerminated).not.toHaveBeenCalled();
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('closes an ordinary helper child once its turn is reported', async () => {
    const child = instance({ outputBuffer: [message('assistant', 'Done.')] });
    const handler = createHandler();

    await handler.handleChildExit(child.id, child, 0);

    expect(orchestration.notifyChildTerminated.mock.calls[0]?.slice(0, 2)).toEqual(['parent-1', child.id]);
    expect(terminateInstance).toHaveBeenCalledWith(child.id, false);
  });

  it('persists a summary when the child exits with an empty buffer', async () => {
    const child = instance({ outputBuffer: [] });
    const handler = createHandler();

    await handler.handleChildExit(child.id, child, 0);

    expect(storage.storeFromOutputBuffer).toHaveBeenCalledTimes(1);
    const [, , , storedSummary, storedSuccess] = storage.storeFromOutputBuffer.mock.calls[0];
    expect(storedSummary).toBe('Child exited without producing any output.');
    expect(storedSuccess).toBe(false);
  });
});
