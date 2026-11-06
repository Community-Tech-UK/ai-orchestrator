/**
 * Harness guidance survives the CLI adopting its own session id (Step 10,
 * A12, item 6).
 *
 * The first output of a turn can carry a provider session id that differs from
 * the one the instance was created with; `InstanceCommunicationManager` adopts
 * it and must tell the guidance latch it is still the same conversation
 * (`getHarnessGuidance().adoptProviderSessionId`). Without that call the latch
 * is keyed to the old id, the next scheduling ask looks like a new
 * conversation, and the full rules are sent a second time instead of the
 * one-line repeat. Drives the real communication manager and the real latch.
 *
 * Mock preamble is the subset of `instance-communication.spec.ts` this path
 * needs.
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

const communicationLoggerMocks = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => communicationLoggerMocks,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false, sessionHandoffStateEnabled: false }),
  }),
}));

vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    storeMessages: vi.fn().mockResolvedValue(undefined),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  }),
}));

vi.mock('../plugins/hook-emitter', () => ({
  emitPluginHook: vi.fn(),
}));

vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

const mockWriteThroughIdentity = vi.fn().mockResolvedValue(undefined);
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => ({
    writeThroughIdentity: mockWriteThroughIdentity,
    markConversationIncomplete: vi.fn(),
  }),
}));

vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    recordUserSend: vi.fn(() => ({ admissionId: 'adm-default' })),
    markDelivered: vi.fn(),
    markFailed: vi.fn(),
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';
import { getHarnessGuidance } from '../orchestration/harness-guidance';
import {
  SCHEDULING_RULES_REPEAT_LINE,
} from '../orchestration/orchestration-protocol.prompts';

const SCHEDULING_ASK = 'Set up a daily check of CI at 9am';
const SCHEDULING_HEADING = '## Harness scheduling rules';

class FakeAdapter extends EventEmitter {
  sendInput = vi.fn().mockResolvedValue(undefined);
  terminate = vi.fn().mockResolvedValue(undefined);

  constructor(private readonly cliSessionId: string) {
    super();
  }

  getName(): string {
    return 'claude-cli';
  }

  getSessionId(): string | null {
    return this.cliSessionId;
  }

  getCurrentTurnId(): string | null {
    return null;
  }
}

function createInstance(): Instance {
  return {
    id: 'instance-1',
    displayName: 'Test Instance',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'idle',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: Date.now(),
    processId: 12345,
    sessionId: 'created-session',
    providerSessionId: 'created-session',
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    currentModel: undefined,
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    restartEpoch: 0,
  };
}

function assistantMessage(content: string): OutputMessage {
  return { id: 'msg-1', timestamp: Date.now(), type: 'assistant', content };
}

async function flushOutputHandlers(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('InstanceCommunicationManager Harness guidance session-id adoption', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let manager: InstanceCommunicationManager;

  beforeEach(() => {
    getHarnessGuidance()._resetForTesting();
    mockWriteThroughIdentity.mockClear();
    instance = createInstance();
    adapters = new Map();
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => { adapters.set(id, adapter); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: vi.fn(),
      captureProviderRuntimeEvent: vi.fn(),
    });
  });

  it('keeps the delivered latch when the CLI assigns its own session id, so the next ask gets the one-line repeat', async () => {
    const guidance = getHarnessGuidance();

    // The rules go out once under the id the instance was created with.
    const first = guidance.takeHarnessGuidance(instance, SCHEDULING_ASK, 'later-turn');
    expect(first.text).toContain(SCHEDULING_HEADING);
    first.commit();

    // The CLI reports a different id on its first output.
    const adapter = new FakeAdapter('cli-assigned-session') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', assistantMessage('On it.'));
    await flushOutputHandlers();

    expect(instance.providerSessionId).toBe('cli-assigned-session');
    expect(mockWriteThroughIdentity).toHaveBeenCalledWith(instance.id, { sessionId: 'cli-assigned-session' });

    // Same conversation: the rules are not sent in full a second time.
    const second = guidance.takeHarnessGuidance(instance, SCHEDULING_ASK, 'later-turn');
    expect(second.text).toBe(SCHEDULING_RULES_REPEAT_LINE);
  });

  it('control: an id change that is not adopted is treated as a new conversation and gets the full rules again', () => {
    const guidance = getHarnessGuidance();
    guidance.takeHarnessGuidance(instance, SCHEDULING_ASK, 'later-turn').commit();

    // A replacement id set directly (fresh restart / replay fallback), with
    // no adoption call.
    instance.providerSessionId = 'replacement-session';

    const next = guidance.takeHarnessGuidance(instance, SCHEDULING_ASK, 'later-turn');
    expect(next.text).toContain(SCHEDULING_HEADING);
  });
});
