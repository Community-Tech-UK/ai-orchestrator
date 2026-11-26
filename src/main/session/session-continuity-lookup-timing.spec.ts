import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionState } from './session-continuity.types';

const state = vi.hoisted(() => ({
  userDataDir: '',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('electron', () => ({ app: { getPath: () => state.userDataDir } }));
vi.mock('../logging/logger', () => ({ getLogger: () => state.logger }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => true }) }));
import { SessionContinuityManager } from './session-continuity';
import { _resetSessionPersistenceQueueForTesting } from './session-persistence-queue';

describe('identifier lookup scan timing', () => {
  let manager: SessionContinuityManager;
  let stateDir: string;
  const scanLogs = () => state.logger.info.mock.calls.filter(([message]) => message === 'Identifier lookup scanned state files');
  const writeState = async (instanceId: string, historyThreadId?: string) => {
    const payload: SessionState = {
      instanceId, historyThreadId, displayName: 'Fixture', agentId: 'build', modelId: 'placeholder-model',
      workingDirectory: '/fixture', conversationHistory: [], contextUsage: { used: 0, total: 1000 },
      pendingTasks: [], environmentVariables: {}, activeFiles: [], skillsLoaded: [], hooksActive: [],
    };
    await fs.writeFile(path.join(stateDir, `${instanceId}.json`), JSON.stringify(payload));
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    state.userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-lookup-timing-'));
    stateDir = path.join(state.userDataDir, 'session-continuity', 'states');
    manager = new SessionContinuityManager({ autoSaveEnabled: false });
    await manager.waitForRecoveryDiscoveryReady();
  });
  afterEach(async () => {
    manager.shutdown();
    await _resetSessionPersistenceQueueForTesting();
    await fs.rm(state.userDataDir, { recursive: true, force: true });
  });

  it('logs one full miss with only the JSON files actually read', async () => {
    await writeState('first');
    await writeState('second');
    await fs.writeFile(path.join(stateDir, 'ignored.tmp'), 'ignored');
    expect(await manager.loadRecoveryState('missing')).toBeNull();
    expect(scanLogs()).toEqual([['Identifier lookup scanned state files', { scanned: 2, fileStats: 5, directoryReads: 2, ms: expect.any(Number), found: false }]]);
    expect(scanLogs()[0][1].ms).toBeGreaterThanOrEqual(0);
  });

  it('logs a found alias after the actual file read', async () => {
    await writeState('instance', 'history-alias');
    expect(await manager.loadRecoveryState('history-alias')).toMatchObject({ instanceId: 'instance' });
    expect(scanLogs()).toEqual([['Identifier lookup scanned state files', { scanned: 1, fileStats: 4, directoryReads: 2, ms: expect.any(Number), found: true }]]);
  });

  it('does not report a scan for a direct filename hit', async () => {
    await writeState('instance');
    expect(await manager.loadRecoveryState('instance')).toMatchObject({ instanceId: 'instance' });
    expect(scanLogs()).toEqual([]);
  });
});
