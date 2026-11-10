import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BackgroundTaskManager } from '../background-task-manager';

/** Resolves when the task reaches a terminal event (completed, failed or cancelled). */
function settled(manager: BackgroundTaskManager, taskId: string): Promise<void> {
  const events = ['task-completed', 'task-failed', 'task-cancelled'] as const;
  return new Promise(resolve => {
    const onEvent = (task: { id: string }) => {
      if (task.id !== taskId) return;
      for (const event of events) manager.off(event, onEvent);
      resolve();
    };
    for (const event of events) manager.on(event, onEvent);
  });
}

/** A short pause after the terminal event, so a duplicate event would still be counted. */
const afterSettle = () => new Promise(resolve => setTimeout(resolve, 20));

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager;

  beforeEach(() => {
    BackgroundTaskManager._resetForTesting();
    manager = BackgroundTaskManager.getInstance();
    manager.configure({ autoStart: true, maxConcurrent: 3 });
  });

  describe('notification deduplication', () => {
    it('emits task-completed only once per task', async () => {
      const completedHandler = vi.fn();
      manager.on('task-completed', completedHandler);

      manager.registerExecutor('fast', async () => 'done');

      const task = manager.submit({
        name: 'dedup-test',
        type: 'fast',
      });

      await settled(manager, task.id);
      await afterSettle();

      const completions = completedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === task.id
      );
      expect(completions).toHaveLength(1);
    });

    it('emits task-failed only once per task even with retries exhausted', async () => {
      const failedHandler = vi.fn();
      manager.on('task-failed', failedHandler);

      manager.registerExecutor('failing', async () => {
        throw new Error('boom');
      });

      const task = manager.submit({
        name: 'fail-dedup-test',
        type: 'failing',
        maxRetries: 0,
      });

      await settled(manager, task.id);
      await afterSettle();

      const failures = failedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === task.id
      );
      expect(failures).toHaveLength(1);
    });

    it.each([
      ['throws', true],
      ['returns', false],
    ])('emits task-cancelled exactly once when a running task is cancelled and its executor then %s', async (_label, throws) => {
      const cancelledHandler = vi.fn();
      const otherHandler = vi.fn();
      manager.on('task-cancelled', cancelledHandler);
      manager.on('task-failed', otherHandler);
      manager.on('task-completed', otherHandler);

      // The executor stays running until the test has asked to cancel it.
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      manager.registerExecutor('slow', async (_task, ctx) => {
        await released;
        if (throws && ctx.isCancelled()) throw new Error('cancelled');
        return 'done';
      });

      const task = manager.submit({
        name: 'cancel-dedup-test',
        type: 'slow',
        cancellable: true,
      });

      expect(manager.getTask(task.id)?.status).toBe('running');
      const done = settled(manager, task.id);
      manager.cancel(task.id);
      release();

      await done;
      await afterSettle();

      const cancellations = cancelledHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === task.id
      );
      expect(cancellations).toHaveLength(1);
      expect(otherHandler).not.toHaveBeenCalled();
      expect(manager.getHistory().find(t => t.id === task.id)?.status).toBe('cancelled');
    });

    it('fails, without retrying, a task whose executor throws after its timeout', async () => {
      const failedHandler = vi.fn();
      const retryHandler = vi.fn();
      manager.on('task-failed', failedHandler);
      manager.on('task-retry-scheduled', retryHandler);

      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      manager.on('task-timeout', () => release());
      manager.registerExecutor('slow', async (_task, ctx) => {
        await released;
        if (ctx.isCancelled()) throw new Error('timed out');
        return 'done';
      });

      const task = manager.submit({ name: 'timeout-test', type: 'slow', timeout: 10 });

      await settled(manager, task.id);
      await afterSettle();

      expect(failedHandler).toHaveBeenCalledTimes(1);
      expect(retryHandler).not.toHaveBeenCalled();
      expect(manager.getHistory().find(t => t.id === task.id)?.status).toBe('failed');
    });
  });

  describe('failed dependency propagation', () => {
    it('fails a task when its dependency has failed', async () => {
      const failedHandler = vi.fn();
      manager.on('task-failed', failedHandler);

      manager.registerExecutor('failing', async () => {
        throw new Error('boom');
      });
      manager.registerExecutor('ok', async () => 'ok');

      const depTask = manager.submit({
        name: 'dependency-task',
        type: 'failing',
        maxRetries: 0,
      });

      const dependentTask = manager.submit({
        name: 'dependent-task',
        type: 'ok',
        dependsOn: [depTask.id],
      });

      await settled(manager, dependentTask.id);
      await afterSettle();

      const dependentFailures = failedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === dependentTask.id
      );
      expect(dependentFailures.length).toBeGreaterThanOrEqual(1);

      const failedTask = dependentFailures[0][0] as { error?: string };
      expect(failedTask.error).toContain('Dependency failed');
    });

    it('fails a task when its dependency was cancelled', async () => {
      const failedHandler = vi.fn();
      manager.on('task-failed', failedHandler);

      // Use maxConcurrent=1 so the dep task stays pending while blocker runs
      manager.configure({ maxConcurrent: 1 });

      let releaseBlocker!: () => void;
      const blockerReleased = new Promise<void>(resolve => { releaseBlocker = resolve; });
      manager.registerExecutor('blocker', async () => {
        await blockerReleased;
        return 'blocking';
      });
      manager.registerExecutor('ok', async () => 'ok');

      // Blocker occupies the single slot
      manager.submit({ name: 'blocker', type: 'blocker' });

      // Dep task is pending (blocked by concurrency)
      const depTask = manager.submit({
        name: 'cancellable-dep',
        type: 'ok',
        cancellable: true,
      });

      // Dependent task is pending (blocked by dependency)
      const dependentTask = manager.submit({
        name: 'dependent-task',
        type: 'ok',
        dependsOn: [depTask.id],
      });

      // Cancel the dep task while it's still pending — triggers immediate transition
      expect(manager.getTask(depTask.id)?.status).toBe('pending');
      const done = settled(manager, dependentTask.id);
      manager.cancel(depTask.id);

      // Free the slot; queue processing then propagates the dependency failure
      releaseBlocker();
      await done;
      await afterSettle();

      const dependentFailures = failedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === dependentTask.id
      );
      expect(dependentFailures.length).toBeGreaterThanOrEqual(1);
    });

    it('runs a task when its dependency completes successfully', async () => {
      const completedHandler = vi.fn();
      manager.on('task-completed', completedHandler);

      manager.registerExecutor('ok', async () => 'ok');

      const depTask = manager.submit({
        name: 'dependency-task',
        type: 'ok',
      });

      const dependentTask = manager.submit({
        name: 'dependent-task',
        type: 'ok',
        dependsOn: [depTask.id],
      });

      await settled(manager, dependentTask.id);
      await afterSettle();

      const dependentCompletions = completedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === dependentTask.id
      );
      expect(dependentCompletions).toHaveLength(1);
    });
  });
});
