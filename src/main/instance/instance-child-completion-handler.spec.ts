import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceChildCompletionHandler } from './instance-child-completion-handler';
import { CHILD_BATCH_MAX_HOLD_MS } from '../orchestration/child-completion-batcher';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { recordSessionPolicy } from '../core/system/session-policy-log';

vi.mock('../core/system/session-policy-log', () => ({ recordSessionPolicy: vi.fn() }));

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
    deliverChildCompleted: vi.fn(),
    getCompletedChildIds: vi.fn(),
    getActiveChildCount: vi.fn<() => number>(),
    notifyAllChildrenCompleted: vi.fn(),
  };
  const terminateInstance = vi.fn();
  const addToOutputBuffer = vi.fn();
  const publishOutput = vi.fn();
  const buildDiagnosticBundle = vi.fn();
  const handlers: InstanceChildCompletionHandler[] = [];

  function createHandler(parent = instance({ id: 'parent-1', parentId: null })): InstanceChildCompletionHandler {
    const handler = new InstanceChildCompletionHandler({
      getInstance: (id) => (id === parent.id ? parent : undefined),
      addToOutputBuffer,
      publishOutput,
      terminateInstance,
      getOrchestrationHandler: () => orchestration,
      storage,
      taskManager,
      buildDiagnosticBundle,
    });
    handlers.push(handler);
    return handler;
  }

  beforeEach(() => {
    vi.resetAllMocks();
    buildDiagnosticBundle.mockResolvedValue(undefined);
    storage.hasResult.mockReturnValue(false);
    storage.storeFromOutputBuffer.mockResolvedValue(undefined);
    storage.getChildSummary.mockResolvedValue(null);
    taskManager.getTaskByChildId.mockReturnValue(null);
    orchestration.notifyChildTerminated.mockReturnValue({ remainingChildren: 1 });
    orchestration.getCompletedChildIds.mockReturnValue([]);
    orchestration.getActiveChildCount.mockImplementation(() => {
      const last = orchestration.notifyChildTerminated.mock.results.at(-1);
      return last?.type === 'return' ? last.value.remainingChildren : 0;
    });
    terminateInstance.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const handler of handlers.splice(0)) handler.dispose();
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

  it('holds the first successful burst result and sends one synthesis for the wave', async () => {
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1_000);
    storage.getChildSummary.mockImplementation(async (id: string) => ({
      resultId: id, summary: `Result ${id}`, success: true, conclusions: [], artifactCount: 0,
    }));
    orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 1 })
      .mockReturnValueOnce({ remainingChildren: 0 });
    orchestration.getCompletedChildIds.mockReturnValue(['a', 'b']);

    await handler.handleChildExit('a', instance({ id: 'a' }), 0);
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    await handler.handleChildExit('b', instance({ id: 'b' }), 0);

    expect(orchestration.notifyAllChildrenCompleted).toHaveBeenCalledOnce();
    expect(orchestration.notifyAllChildrenCompleted.mock.calls[0][1]).toMatchObject([
      { childId: 'a', summary: 'Result a' }, { childId: 'b', summary: 'Result b' },
    ]);
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    expect(orchestration.notifyChildTerminated).toHaveBeenCalledTimes(2);
  });

  it('sends a failed child at once without a second bookkeeping call', async () => {
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1_000);
    storage.getChildSummary.mockResolvedValue({
      resultId: 'a', summary: 'Failed', success: false, conclusions: [], artifactCount: 0,
    });

    await handler.handleChildExit('a', instance({ id: 'a' }), 1);

    expect(orchestration.notifyChildTerminated).toHaveBeenCalledOnce();
    expect(orchestration.notifyChildTerminated.mock.calls[0][3]).toEqual({ deliver: false });
    expect(orchestration.deliverChildCompleted).toHaveBeenCalledWith('parent-1', 'a', expect.objectContaining({ success: false }));
  });

  it('a second wave lists only new children', async () => {
    const handler = createHandler();
    storage.getChildSummary.mockImplementation(async (id: string) => ({
      resultId: id, summary: `Result ${id}`, success: true, conclusions: [], artifactCount: 0,
    }));
    orchestration.notifyChildTerminated.mockReturnValue({ remainingChildren: 0 });
    orchestration.getCompletedChildIds.mockReturnValueOnce(['a']).mockReturnValueOnce(['a', 'b']);

    await handler.handleChildExit('a', instance({ id: 'a' }), 0);
    await handler.handleChildExit('b', instance({ id: 'b' }), 0);

    expect(orchestration.notifyAllChildrenCompleted).toHaveBeenCalledTimes(2);
    expect(orchestration.notifyAllChildrenCompleted.mock.calls[1][1]).toMatchObject([{ childId: 'b' }]);
  });

  it('an older running child does not keep a finished burst waiting for the timer', async () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler();
      // x is long-running and outside the burst; y and z are spawned together later.
      handler.noteSpawn('parent-1', 'x', 0);
      handler.noteSpawn('parent-1', 'y', 100_000);
      handler.noteSpawn('parent-1', 'z', 101_000);
      storage.getChildSummary.mockImplementation(async (id: string) => ({
        resultId: id, summary: `Result ${id}`, success: true, conclusions: [], artifactCount: 0,
      }));
      // x never exits, so the parent's running count is 2 after y and 1 after z.
      orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 2 })
        .mockReturnValueOnce({ remainingChildren: 1 });
      orchestration.getCompletedChildIds.mockReturnValue(['y', 'z']);

      await handler.handleChildExit('y', instance({ id: 'y' }), 0);
      expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
      await handler.handleChildExit('z', instance({ id: 'z' }), 0);

      // Final decision reached on exit, with remainingChildren still 1 and no timer wait.
      expect(orchestration.notifyAllChildrenCompleted).toHaveBeenCalledOnce();
      const [parentId, summaries, options] = orchestration.notifyAllChildrenCompleted.mock.calls[0];
      expect(parentId).toBe('parent-1');
      expect(summaries).toMatchObject([{ childId: 'y', summary: 'Result y' }, { childId: 'z', summary: 'Result z' }]);
      expect(options).toEqual({ othersStillRunning: true });
      expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(terminateInstance).toHaveBeenCalledWith('y', false);
      expect(terminateInstance).toHaveBeenCalledWith('z', false);
      expect(terminateInstance).not.toHaveBeenCalledWith('x', false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a held result is still written to the parent transcript and stored', async () => {
    const parent = instance({ id: 'parent-1', parentId: null });
    const handler = createHandler(parent);
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1_000);
    storage.getChildSummary.mockResolvedValue({
      resultId: 'a', summary: 'Result a', success: true, conclusions: ['Finding one'], artifactCount: 0,
    });
    orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 1 });

    await handler.handleChildExit('a', instance({ id: 'a', displayName: 'Child A' }), 0);

    // Held: the parent is not woken for it...
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
    // ...but the result is stored and on the parent's screen and transcript.
    expect(storage.storeFromOutputBuffer).toHaveBeenCalledOnce();
    expect(storage.storeFromOutputBuffer.mock.calls[0][0]).toBe('a');
    expect(addToOutputBuffer).toHaveBeenCalledOnce();
    const [target, written] = addToOutputBuffer.mock.calls[0];
    expect(target).toBe(parent);
    expect(written).toMatchObject({
      type: 'system',
      metadata: { source: 'child-result', childId: 'a', exitCode: 0 },
    });
    expect(written.content).toContain('Child A');
    expect(written.content).toContain('Result a');
    expect(written.content).toContain('- Finding one');
    expect(publishOutput).toHaveBeenCalledExactlyOnceWith('parent-1', written);
  });

  it('children spawned 5 minutes apart are not held', async () => {
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 5 * 60_000);
    storage.getChildSummary.mockImplementation(async (id: string) => ({
      resultId: id, summary: `Result ${id}`, success: true, conclusions: [], artifactCount: 0,
    }));
    orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 1 });

    // b is still running, but it is outside a's burst, so a is today's behaviour.
    await handler.handleChildExit('a', instance({ id: 'a' }), 0);

    expect(orchestration.deliverChildCompleted).toHaveBeenCalledExactlyOnceWith(
      'parent-1', 'a', expect.objectContaining({ success: true, summary: 'Result a' }),
    );
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').get('parent-1').holdTimer).toBeNull();
  });

  it('a held result released by the timer goes through deliverChildCompleted and is bookkept once', async () => {
    vi.useFakeTimers();
    try {
      const handler = createHandler();
      handler.noteSpawn('parent-1', 'a', 0);
      handler.noteSpawn('parent-1', 'b', 1_000);
      storage.getChildSummary.mockImplementation(async (id: string) => ({
        resultId: id, summary: `Result ${id}`, success: true, conclusions: [], artifactCount: 0,
      }));
      orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 1 });

      await handler.handleChildExit('a', instance({ id: 'a' }), 0);
      expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
      expect(orchestration.notifyChildTerminated).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(CHILD_BATCH_MAX_HOLD_MS);

      expect(orchestration.deliverChildCompleted).toHaveBeenCalledExactlyOnceWith(
        'parent-1', 'a', expect.objectContaining({ name: 'Child', summary: 'Result a', success: true }),
      );
      // Failure streak and active-to-completed move happen in notifyChildTerminated
      // only. The release must not call it again (that would count a failure twice).
      expect(orchestration.notifyChildTerminated).toHaveBeenCalledOnce();
      expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Guards `batcher.markReported` in the release callback. Without it, A is
  // delivered by the failure release and then listed again by C's synthesis.
  it.each([
    { name: 'an older child is still running', remainingAtC: 1 },
    { name: 'C is the last child of the set', remainingAtC: 0 },
  ])('a result released by a failed burst-mate is reported once, not again by the final synthesis ($name)', async ({ remainingAtC }) => {
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1_000);
    handler.noteSpawn('parent-1', 'c', 2_000);
    storage.getChildSummary.mockImplementation(async (id: string) => ({
      resultId: id, summary: `Result ${id}`, success: id !== 'b', conclusions: [], artifactCount: 0,
    }));
    orchestration.notifyChildTerminated
      .mockReturnValueOnce({ remainingChildren: 2 + remainingAtC })
      .mockReturnValueOnce({ remainingChildren: 1 + remainingAtC })
      .mockReturnValueOnce({ remainingChildren: remainingAtC });
    orchestration.getCompletedChildIds.mockReturnValue(['a', 'b', 'c']);

    await handler.handleChildExit('a', instance({ id: 'a' }), 0);
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    await handler.handleChildExit('b', instance({ id: 'b' }), 1);
    await handler.handleChildExit('c', instance({ id: 'c' }), 0);

    // b's failure woke the parent at once and released a with it.
    expect(orchestration.deliverChildCompleted.mock.calls.map((call) => call[1]).sort()).toEqual(['a', 'b']);
    expect(orchestration.notifyAllChildrenCompleted).toHaveBeenCalledOnce();
    const listed = orchestration.notifyAllChildrenCompleted.mock.calls[0][1].map((entry: { childId: string }) => entry.childId);
    expect(listed).toEqual(['c']);
    // Every child reaches the parent exactly once across both channels.
    const everything = [
      ...orchestration.deliverChildCompleted.mock.calls.map((call) => call[1] as string),
      ...listed,
    ].sort();
    expect(everything).toEqual(['a', 'b', 'c']);
  });

  it.each([
    { success: true, exit: 0, expected: true },
    { success: false, exit: 0, expected: false },
    { success: true, exit: 1, expected: false },
    { success: undefined, exit: 0, expected: null },
  ])('records the authoritative Codex child outcome without message content: %j', async ({ success, exit, expected }) => {
    storage.getChildSummary.mockResolvedValue(success === undefined ? null : {
      resultId: 'result-placeholder', summary: 'private result text', success, conclusions: [], artifactCount: 0,
    });
    const child = instance({ provider: 'codex', providerSessionId: 'provider-thread', sessionId: 'old-alias' });
    const handler = createHandler();
    await handler.handleChildExit(child.id, child, exit);
    await handler.handleChildExit(child.id, child, exit);
    expect(recordSessionPolicy).toHaveBeenCalledExactlyOnceWith({
      provider: 'codex', recordType: 'child-outcome', threadId: 'provider-thread',
      instanceId: 'child-1', parentId: 'parent-1', success: expected, exitCode: exit,
    });
    expect(JSON.stringify(vi.mocked(recordSessionPolicy).mock.calls)).not.toContain('private result text');
  });

  it.each(['remove', 'dispose'] as const)('fences an exit awaiting its stored summary after %s, retaining child cleanup', async (action) => {
    let resume!: (value: null) => void;
    storage.getChildSummary.mockImplementationOnce(() => new Promise<null>((resolve) => { resume = resolve; }));
    const handler = createHandler();
    const work = handler.handleChildExit('a', instance({ id: 'a' }), 0);
    await vi.waitFor(() => expect(storage.getChildSummary).toHaveBeenCalledOnce());
    if (action === 'remove') handler.removeParent('parent-1');
    else handler.dispose();
    resume(null);
    await work;
    expect(orchestration.notifyChildTerminated).not.toHaveBeenCalled();
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').size).toBe(0);
    expect(taskManager.cleanupChildTasks).toHaveBeenCalledWith('a');
    expect(terminateInstance).toHaveBeenCalledWith('a', false);
  });

  it('does not dispatch after removal while a failed child diagnostic is pending', async () => {
    let resume!: () => void;
    buildDiagnosticBundle.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    storage.getChildSummary.mockResolvedValue(null);
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1);
    const work = handler.handleChildExit('a', instance({ id: 'a' }), 1);
    await vi.waitFor(() => expect(buildDiagnosticBundle).toHaveBeenCalledOnce());
    handler.removeParent('parent-1');
    resume();
    await work;
    expect(orchestration.notifyChildTerminated).toHaveBeenCalledOnce();
    expect(orchestration.deliverChildCompleted).not.toHaveBeenCalled();
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').size).toBe(0);
    expect(terminateInstance).toHaveBeenCalledWith('a', false);
  });

  it('suppresses a synthesis whose summary reads finish after parent removal, but terminates completed children', async () => {
    let resume!: (value: null) => void;
    storage.getChildSummary.mockResolvedValueOnce(null)
      .mockImplementationOnce(() => new Promise<null>((resolve) => { resume = resolve; }));
    orchestration.notifyChildTerminated.mockReturnValue({ remainingChildren: 0 });
    orchestration.getCompletedChildIds.mockReturnValue(['a']);
    const handler = createHandler();
    const work = handler.handleChildExit('a', instance({ id: 'a' }), 0);
    await vi.waitFor(() => expect(storage.getChildSummary).toHaveBeenCalledTimes(2));
    handler.removeParent('parent-1');
    resume(null);
    await work;
    expect(orchestration.notifyAllChildrenCompleted).not.toHaveBeenCalled();
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').size).toBe(0);
    expect(terminateInstance).toHaveBeenCalledWith('a', false);
  });

  it('does not attribute an in-flight exit to a child orphaned during storage lookup', async () => {
    let resume!: (value: null) => void;
    storage.getChildSummary.mockImplementationOnce(() => new Promise<null>((resolve) => { resume = resolve; }));
    const child = instance({ id: 'a' });
    const handler = createHandler();
    const work = handler.handleChildExit('a', child, 0);
    await vi.waitFor(() => expect(storage.getChildSummary).toHaveBeenCalledOnce());
    child.parentId = null;
    resume(null);
    await work;
    expect(orchestration.notifyChildTerminated).not.toHaveBeenCalled();
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').size).toBe(0);
    expect(terminateInstance).toHaveBeenCalledWith('a', false);
  });


  it('rechecks parent lifetime when failure delivery synchronously removes it', async () => {
    const handler = createHandler();
    handler.noteSpawn('parent-1', 'a', 0);
    handler.noteSpawn('parent-1', 'b', 1);
    handler.noteSpawn('parent-1', 'c', 2);
    storage.getChildSummary.mockResolvedValueOnce({
      resultId: 'a', summary: 'A done', success: true, conclusions: [], artifactCount: 0,
    }).mockResolvedValueOnce({
      resultId: 'b', summary: 'B failed', success: false, conclusions: [], artifactCount: 0,
    });
    orchestration.notifyChildTerminated.mockReturnValueOnce({ remainingChildren: 2 })
      .mockReturnValueOnce({ remainingChildren: 1 });
    await handler.handleChildExit('a', instance({ id: 'a' }), 0);
    orchestration.deliverChildCompleted.mockImplementationOnce(() => handler.removeParent('parent-1'));
    await handler.handleChildExit('b', instance({ id: 'b' }), 1);
    expect(orchestration.deliverChildCompleted.mock.calls.map((call) => call[1])).toEqual(['a']);
    expect(Reflect.get(Reflect.get(handler, 'batcher'), 'parents').size).toBe(0);
    expect(terminateInstance.mock.calls).toEqual([['a', false], ['b', false]]);
  });

});
