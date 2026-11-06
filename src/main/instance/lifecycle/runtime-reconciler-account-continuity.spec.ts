import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
import { createDefaultContextInheritance } from '../../../shared/types/supervision.types';
import type { SessionContinuityManager as ContinuityManager } from '../../session/session-continuity';
import type { UnifiedSpawnOptions } from '../../cli/adapters/adapter-factory';

const runtime = vi.hoisted(() => ({ directory: '', continuity: null as ContinuityManager | null }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => runtime.directory } }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => true }) }));
vi.mock('../../session/session-continuity', async (original) => ({
  ...await original<typeof import('../../session/session-continuity')>(),
  getSessionContinuityManager: () => runtime.continuity,
  getSessionContinuityManagerIfInitialized: () => runtime.continuity,
}));
vi.mock('../../context-evidence/evidence-conversation-resolver', () => ({ initializeInstanceEvidenceOwnership: vi.fn(async () => undefined) }));
vi.mock('../../providers/activity-state-detector', () => ({ ActivityStateDetector: class { setPid = vi.fn(); } }));
vi.mock('../../process/hibernation-manager', () => ({ getHibernationManager: () => ({ markHibernated: vi.fn(), markAwoken: vi.fn() }) }));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getProfile: (_provider: string, id: string) => ({ id, provider: 'opencode', label: id, region: 'ams', isLegacy: id === 'legacy' }),
    getPoolPolicy: () => ({ continuation: 'shared-store' }),
  }),
}));
vi.mock('../../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => ({ admit: vi.fn(async () => ({ ok: true })) }),
}));

import { SessionContinuityManager } from '../../session/session-continuity';
import { getSessionMutex } from '../../session/session-mutex';
import { getSessionPersistenceQueue, _resetSessionPersistenceQueueForTesting } from '../../session/session-persistence-queue';
import { InstanceLifecycleManager } from '../instance-lifecycle';
import { tryAccountSwitchInPlace, snapshotAccount } from './runtime-reconciler-account-handoff';

beforeEach(async () => {
  runtime.directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mimo-account-continuity-'));
  runtime.continuity = new SessionContinuityManager({ autoSaveEnabled: false, encryptOnDisk: false });
  await runtime.continuity.waitForRecoveryDiscoveryReady();
});
afterEach(async () => {
  runtime.continuity?.shutdown();
  await getSessionPersistenceQueue().shutdown({ drain: true });
  _resetSessionPersistenceQueueForTesting();
  runtime.continuity = null;
  await fs.rm(runtime.directory, { recursive: true, force: true });
});

describe('MiMo account handoff continuity', () => {
  it('keeps the switched account through immediate real hibernate and wake without a provider turn', async () => {
    const instance: Instance = {
      id: 'example-session', displayName: 'Example MiMo', provider: 'opencode',
      accountProfileId: 'legacy', accountRoutingSource: 'explicit', accountSwitches: 0,
      currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro', reasoningEffort: 'low',
      workingDirectory: runtime.directory, sessionId: 'example-native-session', historyThreadId: 'example-history',
      status: 'idle', processId: 41, providerSessionPersisted: true, executionLocation: { type: 'local' },
      yoloMode: false, childrenIds: [], agentId: 'build', lastActivity: Date.now(),
      createdAt: Date.now(), parentId: null, supervisorNodeId: '', depth: 0,
      terminationPolicy: 'terminate-children', contextInheritance: createDefaultContextInheritance(), agentMode: 'build',
      planMode: { enabled: false, state: 'off' }, providerSessionId: 'example-native-session', restartEpoch: 0,
      launchMode: 'orchestrated', outputBufferMaxSize: 1000, communicationTokens: new Map(), subscribedTo: [],
      totalTokensUsed: 0, requestCount: 0, errorCount: 0, restartCount: 0,
      contextUsage: { used: 1, total: 200000, percentage: 0 },
      outputBuffer: [
        { id: 'example-user', type: 'user', content: 'Remember the example marker.', timestamp: 1 },
        { id: 'example-reply', type: 'assistant', content: 'Example marker remembered.', timestamp: 2 },
      ],
    };
    const continuity = runtime.continuity!;
    await continuity.startTracking(instance);
    const cursor = { provider: 'opencode' as const, threadId: instance.sessionId!,
      workspacePath: runtime.directory, capturedAt: Date.now(), scanSource: 'native' as const };
    await continuity.updateState(instance.id, { resumeCursor: cursor });
    const adapter = {
      applyLiveSessionConfig: vi.fn(async () => undefined), sendInput: vi.fn(async () => undefined),
      queueNextPromptContext: vi.fn(), removeAllListeners: vi.fn(), terminate: vi.fn(async () => undefined),
      spawn: vi.fn(async () => 42),
    };
    const release = await getSessionMutex().acquire(instance.id, 'runtime-change');
    try {
      expect(await tryAccountSwitchInPlace({
        instance, desired: { provider: 'opencode', accountProfileId: 'example-mimo-b', accountHandoffKind: 'explicit', accountHandoffConfirmed: true },
        adapter, oldAccount: snapshotAccount(instance), assertCurrent: () => undefined,
        emitSystemNotice: vi.fn(), queueUpdate: vi.fn(), emitRuntimeChanged: vi.fn(),
      })).toBe(true);
    } finally { release(); }
    expect(adapter.applyLiveSessionConfig).toHaveBeenCalledWith({
      model: 'aio-mimo-example-mimo-b/mimo-v2.6-pro', effort: 'low',
    });
    expect(adapter.sendInput).not.toHaveBeenCalled();
    expect(continuity.getSessionState(instance.id)?.accountProfileId).toBe('example-mimo-b');
    expect(continuity.getSessionState(instance.id)?.resumeCursor).toEqual(cursor);
    expect(instance.providerSessionId).toBe('example-native-session');

    // Exercise the actual lifecycle methods, with provider I/O replaced at
    // its boundary. A stale saved stamp reaches construction and fails here.
    const manager = Object.setPrototypeOf(new EventEmitter(), InstanceLifecycleManager.prototype) as InstanceLifecycleManager;
    const createRuntimeAdapter = vi.fn(async (_cli: string, options: UnifiedSpawnOptions) => {
      expect(instance.accountProfileId).toBe('example-mimo-b');
      expect(options).toMatchObject({ resume: true, model: instance.currentModel, reasoningEffort: 'low' });
      return adapter;
    });
    Object.assign(manager, {
      deps: {
        getInstance: () => instance, getAdapter: () => adapter, queueUpdate: vi.fn(),
        deleteAdapter: vi.fn(), setAdapter: vi.fn(), setupAdapterEvents: vi.fn(),
        addToOutputBuffer: (target: Instance, message: Instance['outputBuffer'][number]) => target.outputBuffer.push(message),
      },
      terminator: { warnLostWakeup: vi.fn(), mineTranscript: vi.fn() },
      transitionState: (target: Instance, status: Instance['status']) => { target.status = status; },
      wakesInFlight: new Map(), activityDetectors: new Map(),
      settings: { getAll: () => DEFAULT_SETTINGS },
      resolveCliTypeForInstance: async () => 'opencode', residentClaudeForSpawn: () => false,
      createRuntimeAdapter, waitForInputReadinessBoundary: vi.fn(), waitForResumeHealth: async () => true,
      spawnConfigBuilder: {
        getMcpConfig: () => undefined, getChromeDevtoolsMcpOptions: () => undefined,
        getBrowserGatewayMcpOptions: () => undefined, getPermissionHookPath: () => undefined, getRtkSpawnConfig: () => undefined,
      },
    });
    await manager.hibernateInstance(instance.id);
    expect(instance.status).toBe('hibernated');
    const stateFile = path.join(continuity.getRetentionContext().stateDir, `${instance.id}.json`);
    const envelope = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { data: string };
    expect(JSON.parse(envelope.data)).toMatchObject({ accountProfileId: 'example-mimo-b', accountSwitches: 1, resumeCursor: cursor });
    await manager.wakeInstance(instance.id);
    expect(createRuntimeAdapter).toHaveBeenCalledOnce();
    expect(instance).toMatchObject({ status: 'ready', accountProfileId: 'example-mimo-b', reasoningEffort: 'low', processId: 42,
      currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro', providerSessionId: 'example-native-session' });
    expect(instance.outputBuffer.map(message => message.content)).toEqual(['Remember the example marker.', 'Example marker remembered.']);
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });
});
