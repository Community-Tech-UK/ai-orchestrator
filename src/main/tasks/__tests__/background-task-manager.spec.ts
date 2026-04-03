import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BackgroundTaskManager } from '../background-task-manager';

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

      // Wait for task to complete
      await new Promise(resolve => setTimeout(resolve, 200));

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

      await new Promise(resolve => setTimeout(resolve, 300));

      const failures = failedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === task.id
      );
      expect(failures).toHaveLength(1);
    });

    it('emits task-cancelled only once per task', async () => {
      const cancelledHandler = vi.fn();
      manager.on('task-cancelled', cancelledHandler);

      manager.registerExecutor('slow', async (_task, ctx) => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        if (ctx.isCancelled()) throw new Error('cancelled');
        return 'done';
      });

      const task = manager.submit({
        name: 'cancel-dedup-test',
        type: 'slow',
        cancellable: true,
      });

      await new Promise(resolve => setTimeout(resolve, 50));
      manager.cancel(task.id);

      await new Promise(resolve => setTimeout(resolve, 300));

      const cancellations = cancelledHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === task.id
      );
      // At most one cancellation event
      expect(cancellations.length).toBeLessThanOrEqual(1);
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

      await new Promise(resolve => setTimeout(resolve, 500));

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

      manager.registerExecutor('blocker', async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
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
      manager.cancel(depTask.id);

      // Wait for queue processing to propagate the dependency failure
      await new Promise(resolve => setTimeout(resolve, 500));

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

      await new Promise(resolve => setTimeout(resolve, 500));

      const dependentCompletions = completedHandler.mock.calls.filter(
        (c: unknown[]) => (c[0] as { id: string }).id === dependentTask.id
      );
      expect(dependentCompletions).toHaveLength(1);
    });
  });
});
