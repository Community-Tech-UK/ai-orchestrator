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

function createManager(): TestableManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-continuity-'));
  tempDirs.push(dir);
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
