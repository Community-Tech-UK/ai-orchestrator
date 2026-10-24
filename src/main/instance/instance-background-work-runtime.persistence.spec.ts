import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { SessionState } from '../session/session-continuity.types';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.directory } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../session/safe-storage-accessor', () => ({ getSafeStorage: () => ({ isEncryptionAvailable: () => false }) }));
import * as continuity from '../session/session-continuity';
import { _resetSessionPersistenceQueueForTesting, getSessionPersistenceQueue } from '../session/session-persistence-queue';
import { _resetSessionMutexForTesting } from '../session/session-mutex';
import { outputMessageToContinuityEntry } from '../session/continuity-message-projection';
import { restoreWokenOutputBuffer } from './lifecycle/wake-buffer-restore';
import { bindBackgroundWorkTerminationReporter } from './instance-background-work-runtime';
import { _resetForTesting } from './instance-async-work-registry';

const managers: continuity.SessionContinuityManager[] = [];
const notice: OutputMessage = {
  id: 'placeholder-background-stop', timestamp: 3, type: 'system',
  content: 'Closing this session also stopped 1 background command (sleep 300).',
  metadata: { backgroundCommandsStopped: 1 },
};
class Adapter extends EventEmitter {
  private reporter: ((message: OutputMessage) => void | Promise<void>) | null = null;
  setBackgroundWorkTerminationReporter(reporter: ((message: OutputMessage) => void | Promise<void>) | null): void {
    this.reporter = reporter;
  }
  async terminate(): Promise<void> { await this.reporter?.(notice); }
}
async function createManager() {
  const manager = new continuity.SessionContinuityManager({ autoSaveEnabled: false });
  managers.push(manager);
  await manager.waitForRecoveryDiscoveryReady();
  return manager;
}
beforeEach(async () => { fixture.directory = await mkdtemp(join(tmpdir(), 'aio-background-stop-placeholder-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await getSessionPersistenceQueue().shutdown({ drain: true });
  managers.splice(0).forEach((manager) => manager.shutdown());
  await _resetSessionPersistenceQueueForTesting();
  _resetSessionMutexForTesting();
  _resetForTesting();
  await rm(fixture.directory, { recursive: true, force: true });
});

describe('hibernating background command shutdown persistence', () => {
  it.each([false, true])('survives saved-history wake and app restart, with ordinary output forwarding=%s', async (forwarded) => {
    const manager = await createManager();
    vi.spyOn(continuity, 'getSessionContinuityManagerIfInitialized').mockReturnValue(manager);
    const instance = {
      id: 'placeholder-codex-session', sessionId: 'placeholder-thread', provider: 'codex',
      displayName: 'Placeholder session', agentId: 'build', parentId: null,
      workingDirectory: fixture.directory, status: 'hibernating', lastActivity: 2,
      contextUsage: { used: 0, total: 1000, percentage: 0 },
      outputBuffer: [
        { id: 'placeholder-ask', timestamp: 1, type: 'user', content: 'Run the command.' },
        { id: 'placeholder-answer', timestamp: 2, type: 'assistant', content: 'The command is running.' },
      ],
    } as unknown as Instance;
    const adapter = new Adapter();
    let ordinaryForwarding: Promise<unknown> | undefined;
    bindBackgroundWorkTerminationReporter(instance.id, adapter as unknown as CliAdapter, {
      getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
    }, (message) => {
      instance.outputBuffer.push(message);
      if (forwarded) ordinaryForwarding = manager.addConversationEntry(instance.id, outputMessageToContinuityEntry(message));
    });
    // Hibernation saves first, then detaches listeners and kills the adapter.
    await manager.startTracking(instance);
    await manager.stopTracking(instance.id, true);
    adapter.removeAllListeners();
    await adapter.terminate();
    await ordinaryForwarding;
    const raw = JSON.parse(await readFile(join(manager.getRetentionContext().stateDir, `${instance.id}.json`), 'utf8')) as { data: string };
    const saved = JSON.parse(raw.data) as SessionState;
    expect(saved.conversationHistory.filter((entry) => entry.id === notice.id)).toHaveLength(1);
    restoreWokenOutputBuffer(instance, saved.conversationHistory, 1, 100);
    expect(instance.outputBuffer.at(-1)?.content).toBe(notice.content);
    const restarted = await createManager();
    const recovered = await restarted.loadRecoveryState(instance.id);
    expect(recovered?.conversationHistory.filter((entry) => entry.id === notice.id)).toHaveLength(1);
  });
});
