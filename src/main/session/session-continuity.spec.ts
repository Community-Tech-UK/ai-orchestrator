import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContinuityConfig,
  SessionState,
  SessionSnapshot,
  SessionContinuityManager,
} from './session-continuity';

const mockState = vi.hoisted(() => ({
  userDataDir: '',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockState.userDataDir),
  },
  safeStorage: mockState.safeStorage,
}));

// session-continuity.ts reaches safeStorage through this small relative-path
// seam (see safe-storage-accessor.ts). Mocking it here means the production
// code always uses `mockState.safeStorage` — vitest reliably intercepts
// relative imports between project files, whereas `require('electron')` can
// leak through to Node's native module resolution.
vi.mock('./safe-storage-accessor', () => ({
  getSafeStorage: () => mockState.safeStorage,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => mockState.logger,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn(() => true),
  }),
}));

import { SessionContinuityManager as ImportedSessionContinuityManager } from './session-continuity';
import { getSessionMutex, _resetSessionMutexForTesting } from './session-mutex';

/** Cast-target for accessing private/protected members in tests. */
interface TestableSessionContinuityManager {
  readyPromise: Promise<void>;
  readPayload<T>(filePath: string): Promise<T | null>;
  deserializePayload<T>(raw: string, filePath?: string): T | null;
  getResumableSessions(): Promise<SessionState[]>;
  resumeSession(instanceId: string): Promise<SessionState | null>;
  importSession(data: { state: SessionState; snapshots?: unknown[] }, newInstanceId?: string): Promise<string>;
  addConversationEntry(instanceId: string, entry: SessionState['conversationHistory'][number]): Promise<void>;
  createSnapshot(instanceId: string, name?: string, description?: string, trigger?: string): Promise<SessionSnapshot | null>;
  exportSession(instanceId: string): Promise<{ state: SessionState; snapshots: SessionSnapshot[] } | null>;
  listSnapshots(instanceId?: string): SessionSnapshot[];
  updateState(instanceId: string, updates: Partial<SessionState>): Promise<void>;
  markNativeResumeFailed(instanceId: string, errorCode?: number): Promise<void>;
  writeThroughIdentity(instanceId: string, identity: { sessionId?: string; resumeCursor?: unknown; nativeResumeFailedAt?: number | null }): Promise<void>;
  writeThroughIdentityLocked(instanceId: string, identity: { sessionId?: string; resumeCursor?: unknown; nativeResumeFailedAt?: number | null }): Promise<void>;
  setInstanceManager(instanceManager: { getAdapter(instanceId: string): unknown }): void;
  captureResumeCursor(instanceId: string, state: SessionState): void;
  exportSession(instanceId: string): Promise<{ state: SessionState; snapshots: SessionSnapshot[] } | null>;
  shutdown(): void;
}

function makeState(instanceId: string): SessionState {
  return {
    instanceId,
    displayName: `Session ${instanceId}`,
    agentId: 'agent-1',
    modelId: 'claude-3-5-sonnet',
    workingDirectory: '/workspace',
    conversationHistory: [
      {
        id: 'entry-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      },
    ],
    contextUsage: {
      used: 123,
      total: 200000,
    },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  };
}

function createEnvelope(data: unknown): string {
  return JSON.stringify({
    encrypted: false,
    data: JSON.stringify(data),
  });
}

function getLogCall(calls: unknown[][], message: string): unknown[] | undefined {
  return calls.find(([entry]) => entry === message);
}

describe('SessionContinuityManager logging', () => {
  const tempDirs: string[] = [];
  const managers: SessionContinuityManager[] = [];

  function createManager(config: Partial<ContinuityConfig> = {}): TestableSessionContinuityManager {
    const manager = new ImportedSessionContinuityManager({
      autoSaveEnabled: false,
      ...config,
    }) as unknown as TestableSessionContinuityManager;
    managers.push(manager as unknown as SessionContinuityManager);
    return manager;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    mockState.safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'));
    mockState.userDataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'session-continuity-')
    );
    tempDirs.push(mockState.userDataDir);
  });

  it('persists one atomic runtime snapshot without mutating the provider cursor', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const state = { ...makeState('atomic-runtime'), provider: 'codex' as const };
    const providerCursor = Object.freeze({
      provider: 'codex' as const,
      threadId: 'thread-7',
      workspacePath: '/workspace',
      capturedAt: 100,
      scanSource: 'native' as const,
    });
    const getResumeCursor = vi.fn(() => {
      throw new Error('legacy cursor getter must not be read after the snapshot');
    });
    manager.setInstanceManager({
      getAdapter: () => ({
        getRuntimeSnapshot: () => ({
          revision: 7,
          capturedAt: 101,
          providerSessionId: 'thread-7',
          nativeThreadId: 'thread-7',
          resumeCursor: providerCursor,
        }),
        getResumeCursor,
      }),
    });

    manager.captureResumeCursor('atomic-runtime', state);

    expect(state.sessionId).toBe('thread-7');
    expect(state.resumeCursor).toMatchObject({
      threadId: 'thread-7',
      configFingerprint: expect.any(String),
    });
    expect(providerCursor).not.toHaveProperty('configFingerprint');
    expect(getResumeCursor).not.toHaveBeenCalled();
  });

  afterEach(async () => {
    for (const manager of managers.splice(0, managers.length)) {
      manager.shutdown();
    }

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('logs per-file load counts and skipped state files during startup', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, 'good.json'),
      createEnvelope(makeState('good-session'))
    );
    await fs.promises.writeFile(path.join(stateDir, 'bad.json'), '{bad json');

    const manager = createManager();
    await manager.readyPromise;

    const sessions = await manager.getResumableSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.instanceId).toBe('good-session');

    expect(mockState.logger.warn.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'Skipped unloadable session state file',
          expect.objectContaining({
            file: 'bad.json',
            filePath: path.join(stateDir, 'bad.json'),
          }),
        ],
      ])
    );
    expect(mockState.logger.info.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'Session states loaded',
          expect.objectContaining({ loaded: 1, failed: 1, total: 2 }),
        ],
      ])
    );
  });

  it('logs non-ENOENT read failures from readPayload', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    const result = await manager.readPayload('/tmp/blocked.json');

    expect(result).toBeNull();
    const errorCall = getLogCall(mockState.logger.error.mock.calls, 'Failed to read continuity file');
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        path: '/tmp/blocked.json',
        errorCode: 'EACCES',
      })
    );

    readFileSpy.mockRestore();
  });

  it('logs invalid outer JSON with preview metadata', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const result = manager.deserializePayload('{"broken"', '/tmp/invalid.json');

    expect(result).toBeNull();
    const errorCall = getLogCall(mockState.logger.error.mock.calls, 'Session file contains invalid JSON');
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        filePath: '/tmp/invalid.json',
        rawLength: 9,
        rawPreview: '{"broken"',
      })
    );
  });

  it('logs decrypt failures with envelope metadata', async () => {
    const manager = createManager({
      encryptOnDisk: true,
    });
    await manager.readyPromise;
    mockState.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const result = manager.deserializePayload(
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('ciphertext', 'utf8').toString('base64'),
      }),
      '/tmp/encrypted.json'
    );

    expect(result).toBeNull();
    const errorCall = getLogCall(
      mockState.logger.error.mock.calls,
      'Failed to decrypt/parse session payload'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        filePath: '/tmp/encrypted.json',
        encrypted: true,
        dataType: 'string',
      })
    );
  });

  it('resumes a saved state by history thread id and native session id', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const state = makeState('instance-thread-aware');
    state.historyThreadId = 'thread-123';
    state.sessionId = 'native-session-123';

    await fs.promises.writeFile(
      path.join(stateDir, 'instance-thread-aware.json'),
      createEnvelope(state)
    );

    const manager = createManager();
    await manager.readyPromise;

    const byThread = await manager.resumeSession('thread-123');
    const byNativeSession = await manager.resumeSession('native-session-123');

    expect(byThread?.instanceId).toBe('instance-thread-aware');
    expect(byThread?.historyThreadId).toBe('thread-123');
    expect(byNativeSession?.instanceId).toBe('instance-thread-aware');
    expect(byNativeSession?.sessionId).toBe('native-session-123');
  });

  it('stores native session metadata on snapshots while keeping lookups thread-aware', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('instance-snapshot');
    state.historyThreadId = 'thread-snapshot';
    state.sessionId = 'native-session-snapshot';

    await manager.importSession({ state });
    const snapshot = await manager.createSnapshot('instance-snapshot', 'checkpoint');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.instanceId).toBe('instance-snapshot');
    expect(snapshot?.historyThreadId).toBe('thread-snapshot');
    expect(snapshot?.sessionId).toBe('native-session-snapshot');

    const byInstance = manager.listSnapshots('instance-snapshot');
    const byThread = manager.listSnapshots('thread-snapshot');
    const byNativeSession = manager.listSnapshots('native-session-snapshot');

    expect(byInstance).toHaveLength(1);
    expect(byThread).toHaveLength(1);
    expect(byNativeSession).toHaveLength(1);
    expect(byThread[0]?.instanceId).toBe('instance-snapshot');
    expect(byNativeSession[0]?.sessionId).toBe('native-session-snapshot');
  });

  it('marks native resume failures on thread-aware session state and clears them on new native session ids', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('instance-failure');
    state.historyThreadId = 'thread-failure';
    state.sessionId = 'native-session-old';

    await manager.importSession({ state });
    await manager.markNativeResumeFailed('thread-failure', 4242);

    const failedState = await manager.resumeSession('thread-failure');
    expect(failedState?.nativeResumeFailedAt).toBe(4242);

    await manager.updateState('instance-failure', {
      sessionId: 'native-session-new',
    });

    const recoveredState = await manager.resumeSession('thread-failure');
    expect(recoveredState?.sessionId).toBe('native-session-new');
    expect(recoveredState?.nativeResumeFailedAt).toBeNull();
  });

  it('coalesces repeated conversation entry ids before keeping them in continuity state', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('streaming-instance');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('streaming-instance', {
      id: 'assistant-stream-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 1,
    });
    await manager.addConversationEntry('streaming-instance', {
      id: 'assistant-stream-1',
      role: 'assistant',
      content: 'final answer',
      timestamp: 2,
    });

    const exported = await manager.exportSession('streaming-instance');

    expect(exported?.state.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);
  });

  it('normalizes legacy duplicated conversation entries when resuming from disk', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const state = makeState('legacy-duplicates');
    state.conversationHistory = [
      {
        id: 'assistant-stream-1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: 1,
      },
      {
        id: 'assistant-stream-1',
        role: 'assistant',
        content: 'final answer',
        timestamp: 2,
      },
    ];

    const stateFile = path.join(stateDir, 'legacy-duplicates.json');
    await fs.promises.writeFile(stateFile, createEnvelope(state));

    const manager = createManager();
    await manager.readyPromise;

    const resumed = await manager.resumeSession('legacy-duplicates');

    expect(resumed?.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);

    const rewrittenEnvelope = JSON.parse(await fs.promises.readFile(stateFile, 'utf8')) as { data: string };
    const rewrittenState = JSON.parse(rewrittenEnvelope.data) as SessionState;
    expect(rewrittenState.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);
  });

  it('redacts tool conversation entries before keeping them in continuity state', async () => {
    const manager = createManager({
      redactToolOutputs: true,
    });
    await manager.readyPromise;

    const state = makeState('tool-redaction');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('tool-redaction', {
      id: 'tool-result-1',
      role: 'tool',
      content: 'x'.repeat(50_000),
      timestamp: 1,
    });

    const exported = await manager.exportSession('tool-redaction');

    expect(exported?.state.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'tool-result-1',
        content: '[REDACTED TOOL OUTPUT]',
      }),
    ]);
  });

  it('loads only the newest configured state files at startup without deleting older resumable files', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    for (const [index, instanceId] of ['old-session', 'middle-session', 'new-session'].entries()) {
      const stateFile = path.join(stateDir, `${instanceId}.json`);
      await fs.promises.writeFile(stateFile, createEnvelope(makeState(instanceId)));
      const mtime = new Date(1_000 + index * 1_000);
      await fs.promises.utimes(stateFile, mtime, mtime);
    }

    const manager = createManager({
      maxLoadedStateFiles: 2,
    });
    await manager.readyPromise;

    const startupSessions = await manager.getResumableSessions();
    expect(startupSessions.map((session) => session.instanceId).sort()).toEqual([
      'middle-session',
      'new-session',
    ]);

    const oldSession = await manager.resumeSession('old-session');
    expect(oldSession?.instanceId).toBe('old-session');
    await fs.promises.access(path.join(stateDir, 'old-session.json'));
  });

  it('quarantines state files whose envelope is structurally valid but whose contents cannot be decrypted', async () => {
    // This reproduces the post-reinstall / Keychain-rotation failure mode:
    // after a new install, `safeStorage.decryptString` throws on ciphertext
    // written by a previous install. The envelope ({encrypted, data}) still
    // parses as valid JSON, so `repairFile()` can't detect it as corrupt and
    // the file would otherwise stay in states/ and re-throw the same decrypt
    // error on every subsequent startup. readPayload must quarantine it so
    // future startups stay clean.
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    const quarantineDir = path.join(mockState.userDataDir, 'session-continuity', 'quarantine');
    await fs.promises.mkdir(stateDir, { recursive: true });

    // Well-formed envelope, but `data` is not real ciphertext. We'll make
    // decryptString throw for this file so deserializePayload returns null.
    const undecryptableFile = path.join(stateDir, 'undecryptable.json');
    await fs.promises.writeFile(
      undecryptableFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('not-real-ciphertext', 'utf8').toString('base64'),
      })
    );

    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockState.safeStorage.decryptString.mockImplementation(() => {
      throw new Error('Decryption failed (simulated post-reinstall key rotation).');
    });

    const manager = createManager({ encryptOnDisk: true });
    await manager.readyPromise;

    // Original file should have been moved into the quarantine directory,
    // and readPayload should have returned null (no resumable session loaded).
    const sessions = await manager.getResumableSessions();
    expect(sessions).toHaveLength(0);

    await expect(fs.promises.access(undecryptableFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const quarantineEntries = await fs.promises.readdir(quarantineDir);
    const quarantinedMatch = quarantineEntries.find((f) =>
      f.startsWith('undecryptable.json.') && f.endsWith('.corrupt'),
    );
    expect(quarantinedMatch).toBeDefined();

    // The warn log should call this out specifically (post-reinstall hint),
    // not bundle it together with a generic "skipped unloadable" message.
    const quarantineLog = getLogCall(
      mockState.logger.warn.mock.calls,
      'Quarantined undecryptable session state file (likely post-reinstall safeStorage key change)',
    );
    expect(quarantineLog).toBeDefined();
    expect(quarantineLog?.[1]).toEqual(
      expect.objectContaining({
        original: undecryptableFile,
        dest: expect.stringContaining(path.join(quarantineDir, 'undecryptable.json.')),
      })
    );
  });

  it('leaves a good encrypted file untouched when its sibling is undecryptable', async () => {
    // Regression guard: the quarantine branch in readPayload must not
    // over-reach and touch files that load cleanly. Here both files use
    // the encrypted envelope; `good-enc.json` decrypts normally while
    // `bad-enc.json` throws inside decryptString.
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const goodState = makeState('good-session');
    const goodFile = path.join(stateDir, 'good-enc.json');
    const badFile = path.join(stateDir, 'bad-enc.json');

    // Both envelopes carry distinguishable "ciphertext" so the mock can
    // tell them apart by the bytes it receives.
    await fs.promises.writeFile(
      goodFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('good-cipher', 'utf8').toString('base64'),
      }),
    );
    await fs.promises.writeFile(
      badFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('bad-cipher', 'utf8').toString('base64'),
      }),
    );

    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockState.safeStorage.decryptString.mockImplementation((value: Buffer) => {
      const cipherText = value.toString('utf8');
      if (cipherText === 'good-cipher') return JSON.stringify(goodState);
      throw new Error(`Simulated decrypt failure for ${cipherText}.`);
    });

    const manager = createManager({ encryptOnDisk: true });
    await manager.readyPromise;

    const sessions = await manager.getResumableSessions();
    const ids = sessions.map((s) => s.instanceId).sort();
    expect(ids).toEqual(['good-session']);

    // decryptString should have been called for BOTH files (once each).
    const decryptCalls = mockState.safeStorage.decryptString.mock.calls.map(([buf]) =>
      (buf as Buffer).toString('utf8'),
    );
    expect(decryptCalls.sort()).toEqual(['bad-cipher', 'good-cipher']);

    // Good file still present, bad file quarantined.
    await fs.promises.access(goodFile);
    await expect(fs.promises.access(badFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('writeThroughIdentity', () => {
    it('updates sessionId and persists immediately', async () => {
      const manager = createManager();
      await manager.readyPromise;

      await manager.importSession({ state: makeState('inst-write-through') });
      await manager.writeThroughIdentity('inst-write-through', { sessionId: 'new-session-123' });

      const exported = await manager.exportSession('inst-write-through');
      expect(exported?.state.sessionId).toBe('new-session-123');
    });

    it('updates nativeResumeFailedAt and persists immediately', async () => {
      const manager = createManager();
      await manager.readyPromise;

      await manager.importSession({ state: makeState('inst-wt-2') });
      await manager.writeThroughIdentity('inst-wt-2', { nativeResumeFailedAt: 9999 });

      const exported = await manager.exportSession('inst-wt-2');
      expect(exported?.state.nativeResumeFailedAt).toBe(9999);
    });

    it('clears nativeResumeFailedAt when passed null', async () => {
      const manager = createManager();
      await manager.readyPromise;

      const state = makeState('inst-wt-clear');
      await manager.importSession({ state });
      await manager.writeThroughIdentity('inst-wt-clear', { nativeResumeFailedAt: 1234 });
      await manager.writeThroughIdentity('inst-wt-clear', { nativeResumeFailedAt: null });

      const exported = await manager.exportSession('inst-wt-clear');
      expect(exported?.state.nativeResumeFailedAt).toBeNull();
    });

    it('is a no-op for an untracked instanceId', async () => {
      const manager = createManager();
      await manager.readyPromise;
      // Should not throw
      await expect(
        manager.writeThroughIdentity('not-tracked', { sessionId: 'x' }),
      ).resolves.toBeUndefined();
    });
  });

  // Regression: lock-holding lifecycle ops (respawn fresh-fallback, YOLO/model/
  // agent-mode toggle) call writeThroughIdentityLocked while already holding the
  // per-instance session lock. The non-reentrant SessionMutex means the public
  // writeThroughIdentity (which acquires inside saveStateAsync) self-deadlocks
  // there — it stalls for the full 120s acquire timeout, surfaces as "CLI not
  // ready for input", and kills the session. The *Locked variant must write
  // under the already-held lock without re-acquiring.
  describe('writeThroughIdentityLocked (re-entrant write under held lock)', () => {
    afterEach(() => {
      _resetSessionMutexForTesting();
    });

    it('persists without re-acquiring while the caller holds the session lock', async () => {
      const manager = createManager();
      await manager.readyPromise;
      await manager.importSession({ state: makeState('inst-locked') });

      const release = await getSessionMutex().acquire('inst-locked', 'test-holder');
      try {
        // If this re-acquired the lock it would block until the 120s timeout.
        // Race against a short deadline so a regression fails in ~1s, not 120s.
        const outcome = await Promise.race([
          manager.writeThroughIdentityLocked('inst-locked', { sessionId: 'locked-session' }).then(() => 'done'),
          new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 1000)),
        ]);
        expect(outcome).toBe('done');
      } finally {
        release();
      }

      const exported = await manager.exportSession('inst-locked');
      expect(exported?.state.sessionId).toBe('locked-session');
    });

    it('public writeThroughIdentity still serializes on the lock (does not bypass it)', async () => {
      const manager = createManager();
      await manager.readyPromise;
      await manager.importSession({ state: makeState('inst-pub') });

      const release = await getSessionMutex().acquire('inst-pub', 'test-holder');
      let settled = false;
      const pending = manager
        .writeThroughIdentity('inst-pub', { sessionId: 'pub-session' })
        .then(() => {
          settled = true;
        });

      // While another op holds the lock, the acquiring path must wait.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      release();
      await pending;
      expect(settled).toBe(true);

      const exported = await manager.exportSession('inst-pub');
      expect(exported?.state.sessionId).toBe('pub-session');
    });
  });
});
