import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GracefulShutdownManager,
  ShutdownPriority,
} from './graceful-shutdown';
import { createHarnessShutdownOperations } from './harness-shutdown-operations';

function dependencies(order: string[]) {
  const step = (name: string) => vi.fn(async () => { order.push(name); });
  return {
    shutdownContinuitySync: vi.fn(() => { order.push('continuity-sync'); }),
    killActiveProcessesSync: vi.fn(() => { order.push('signal-processes'); }),
    stopRemoteServices: step('stop-remote-services'),
    terminateInstances: step('terminate-instances'),
    flushChatTranscripts: step('flush-chat-transcripts'),
    teardownBootstrap: step('bootstrap-teardown'),
    flushObservability: step('flush-observability'),
    runCleanupRegistry: step('cleanup-registry'),
    stopCliSpawnWorker: step('stop-cli-spawn-worker'),
    killOrphanedCliProcesses: step('kill-orphaned-cli-processes'),
  };
}

describe('createHarnessShutdownOperations', () => {
  afterEach(() => GracefulShutdownManager._resetForTesting());

  it('persists continuity synchronously before the production terminate-instances phase', async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const shutdown = createHarnessShutdownOperations(deps);

    shutdown.cleanupSync();
    const report = await shutdown.cleanup();

    expect(order.slice(0, 3)).toEqual([
      'continuity-sync',
      'signal-processes',
      'stop-remote-services',
    ]);
    expect(order.indexOf('continuity-sync')).toBeLessThan(order.indexOf('terminate-instances'));
    expect(report.phases.find((phase) => phase.name === 'terminate-instances')).toMatchObject({
      priority: ShutdownPriority.TERMINATE_INSTANCES,
      status: 'completed',
    });
  });

  it('still signals active processes when synchronous continuity persistence throws', () => {
    const order: string[] = [];
    const deps = dependencies(order);
    deps.shutdownContinuitySync.mockImplementation(() => {
      order.push('continuity-sync');
      throw new Error('Fixture continuity failure');
    });

    createHarnessShutdownOperations(deps).cleanupSync();

    expect(order).toEqual(['continuity-sync', 'signal-processes']);
  });
});
