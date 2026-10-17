import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { SessionState } from './session-continuity';

const mockState = vi.hoisted(() => ({
  userDataDir: '',
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => mockState.userDataDir) },
  safeStorage: mockState.safeStorage,
}));
vi.mock('./safe-storage-accessor', () => ({ getSafeStorage: () => mockState.safeStorage }));
vi.mock('../logging/logger', () => ({ getLogger: () => mockState.logger }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: vi.fn(() => true) }),
}));

import type { OutputMessage } from '../../shared/types/instance.types';
import { SessionContinuityManager } from './session-continuity';

/**
 * The Copilot account profile is a FIRST-CLASS field on both `Instance` and
 * `SessionState`, not an entry in `instance.metadata`. `instanceToState()`
 * builds its result field-by-field and never copies `metadata`, so a profile
 * stamped there would vanish on hibernate — and a woken Copilot session with no
 * profile is one that could resume under the wrong GitHub account.
 */
interface TestableManager {
  readyPromise: Promise<void>;
  instanceToState(instance: Instance): SessionState;
  shutdown(): void;
  importSession(data: { state: SessionState }): Promise<string>;
  resumeSession(instanceId: string): Promise<SessionState | null>;
  updateState(instanceId: string, update: Partial<SessionState>): Promise<void>;
  getRetentionContext(): { stateDir: string };
  getResumableSessions(): Promise<SessionState[]>;
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Session',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'idle',
    contextUsage: { used: 10, total: 200000, percentage: 0 },
    lastActivity: Date.now(),
    processId: null,
    providerSessionId: 'sess-1',
    sessionId: 'sess-1',
    restartEpoch: 0,
    workingDirectory: '/workspace',
    yoloMode: false,
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    ...overrides,
  } as Instance;
}

const tempDirs: string[] = [];
const managers: TestableManager[] = [];

function createManager(existingDirectory?: string): TestableManager {
  const dir = existingDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-continuity-'));
  if (!existingDirectory) tempDirs.push(dir);
  mockState.userDataDir = dir;
  const manager = new SessionContinuityManager({
    autoSaveEnabled: false,
    autoSaveIntervalMs: 0,
    persistSessionContent: true,
  }) as unknown as TestableManager;
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  mockState.logger.info.mockClear();
});

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.readyPromise;
    manager.shutdown();
  }
  for (const dir of tempDirs.splice(0)) {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

describe('instanceToState — Copilot account continuity', () => {
  it('copies the profile, routing source, and rule onto the session state', () => {
    const state = createManager().instanceToState(
      makeInstance({
        copilotAccountProfileId: 'enterprise',
        copilotRoutingSource: 'owner',
        copilotRoutingRuleId: 'rule-7',
      }),
    );
    expect(state.copilotAccountProfileId).toBe('enterprise');
    expect(state.copilotRoutingSource).toBe('owner');
    expect(state.copilotRoutingRuleId).toBe('rule-7');
  });

  it('does NOT recover a profile hidden in the metadata bag', () => {
    // Guard against a future edit moving the stamp into `metadata`: this
    // function does not copy that object, so the profile would be lost with no
    // compiler error. If this test ever starts passing with a metadata-only
    // instance, the stamp has been moved somewhere unsafe.
    const state = createManager().instanceToState(
      makeInstance({ metadata: { copilotAccountProfileId: 'enterprise' } }),
    );
    expect(state.copilotAccountProfileId).toBeUndefined();
  });

  it('copies the Claude/Codex account-pool profile, source and switch count', () => {
    const state = createManager().instanceToState(
      makeInstance({ provider: 'claude', accountProfileId: 'max-b', accountRoutingSource: 'failover', accountSwitches: 2 }),
    );
    expect(state).toMatchObject({ accountProfileId: 'max-b', accountRoutingSource: 'failover', accountSwitches: 2 });
  });

  it('copies the account routing origin and account fence (Plan Queue sessions)', () => {
    const state = createManager().instanceToState(
      makeInstance({ provider: 'codex', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['pro-1', 'pro-2'] }),
    );
    expect(state).toMatchObject({ accountRouteOrigin: 'automation', allowedAccountProfileIds: ['pro-1', 'pro-2'] });
  });

  it('leaves the profile undefined for a non-Copilot session', () => {
    const state = createManager().instanceToState(makeInstance());
    expect(state.copilotAccountProfileId).toBeUndefined();
    expect(state.copilotRoutingSource).toBeUndefined();
  });

  it('round-trips through JSON without loss', () => {
    // Session state is persisted as JSON; `undefined` fields drop out, so a
    // pre-feature record restores as undefined rather than throwing.
    const state = createManager().instanceToState(
      makeInstance({ copilotAccountProfileId: 'personal', copilotRoutingSource: 'default' }),
    );
    const revived = JSON.parse(JSON.stringify(state)) as SessionState;
    expect(revived.copilotAccountProfileId).toBe('personal');
    expect(revived.copilotRoutingSource).toBe('default');

    const legacy = JSON.parse(
      JSON.stringify(createManager().instanceToState(makeInstance())),
    ) as SessionState;
    expect(legacy.copilotAccountProfileId).toBeUndefined();
    expect('copilotAccountProfileId' in legacy).toBe(false);
  });
});

describe('instanceToState — retained prompts survive hibernation', () => {
  const message = (id: string, type: OutputMessage['type'], content: string, timestamp: number) =>
    ({ id, type, content, timestamp }) as OutputMessage;

  it('persists a prompt a trim already evicted from the live buffer', () => {
    // Without this the live buffer is all a checkpoint ever captured, so a
    // hibernate/wake round trip loses the original request permanently.
    const state = createManager().instanceToState(
      makeInstance({
        outputBuffer: [message('a9', 'assistant', 'carrying on', 20)],
        retainedPrompts: [message('p0', 'user', 'Migrate the billing service.', 1)],
      }),
    );

    expect(state.conversationHistory.map((entry) => entry.content)).toEqual([
      'Migrate the billing service.',
      'carrying on',
    ]);
  });

  it('does not duplicate a retained prompt the buffer still holds', () => {
    const opening = message('p0', 'user', 'Migrate the billing service.', 1);
    const state = createManager().instanceToState(
      makeInstance({ outputBuffer: [opening], retainedPrompts: [opening] }),
    );

    expect(state.conversationHistory).toHaveLength(1);
  });
});


describe('instanceToState — OpenCode extra folders', () => {
  it('persists a separate copy of the exact additional roots', () => {
    const directories = ['/work/second', 'C:\\work\\third'];
    const saved = createManager().instanceToState(makeInstance({ provider: 'opencode', additionalDirectories: directories }));
    expect(saved.additionalDirectories).toEqual(directories);
    expect(saved.additionalDirectories).not.toBe(directories);
    directories.push('/work/later');
    expect(saved.additionalDirectories).toEqual(['/work/second', 'C:\\work\\third']);
  });
});


it('keeps extra folder roots across disk persistence and a fresh continuity manager', async () => {
  const manager = createManager();
  const directory = mockState.userDataDir;
  const saved = manager.instanceToState(makeInstance({ provider: 'opencode', additionalDirectories: ['/work/second'] }));
  await manager.importSession({ state: saved });
  manager.shutdown();
  const replacement = createManager(directory);
  const resumed = await replacement.resumeSession('inst-1');
  expect(resumed?.additionalDirectories).toEqual(['/work/second']);
  const nextRoots = ['/work/third'];
  await replacement.updateState('inst-1', { additionalDirectories: nextRoots });
  nextRoots.push('/work/unrequested');
  expect((await replacement.resumeSession('inst-1'))?.additionalDirectories).toEqual(['/work/third']);
  await expect(replacement.updateState('inst-1', { provider: 'claude' })).rejects.toThrow('OpenCode');
  expect((await replacement.resumeSession('inst-1'))?.provider).toBe('opencode');
});


it('skips one corrupt saved folder list while loading other resumable sessions', async () => {
  const manager = createManager();
  const directory = mockState.userDataDir;
  const valid = manager.instanceToState(makeInstance({ provider: 'opencode', additionalDirectories: ['/work/second'] }));
  await manager.importSession({ state: valid });
  fs.writeFileSync(path.join(manager.getRetentionContext().stateDir, 'bad.json'), JSON.stringify({ ...valid, instanceId: 'bad', additionalDirectories: ['relative-root'] }));
  const replacement = createManager(directory);
  const sessions = await replacement.getResumableSessions();
  expect(sessions.map((session) => session.instanceId)).toContain('inst-1');
  expect(sessions.map((session) => session.instanceId)).not.toContain('bad');
});
