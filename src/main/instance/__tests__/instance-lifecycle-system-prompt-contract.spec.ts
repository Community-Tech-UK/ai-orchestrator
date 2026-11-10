/**
 * WS-B4 regression: instance-lifecycle.ts's real system-prompt assembly
 * (createInstance() background init) must route every block through
 * `createSystemPromptComposer()` in `SYSTEM_PROMPT_BLOCK_ORDER` and reproduce
 * the exact pre-refactor concatenation shape — same content, same
 * `\n\n---\n\n` separators, same order. This exercises the REAL
 * InstanceLifecycleManager.createInstance() (not the composer in isolation;
 * see prompt-injection-contract.spec.ts for that) with several of the
 * optional blocks populated, and asserts the system prompt handed to the
 * adapter equals a string built independently in this test from the same
 * inputs.
 *
 * Harness borrowed from instance-lifecycle-spawn-rollback.spec.ts (same
 * mocking shape); trimmed to what createInstance() touches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseCliAdapter } from '../../cli/adapters/base-cli-adapter';
import type { GeminiCliAdapter } from '../../cli/adapters/gemini-cli-adapter';
import type { AntigravityCliAdapter } from '../../cli/adapters/antigravity-cli-adapter';
import type { Instance } from '../../../shared/types/instance.types';
import type { ModelRuntimeTarget } from '../../../shared/types/local-model-runtime.types';
import { encodeLocalModelSelector } from '../../../shared/utils/local-model-selector';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceStateMachine } from '../instance-state-machine';
import { buildToolPermissionPrompt } from '../lifecycle/tool-permission-prompt';
import { getLatestContextManifest } from '../../context/context-manifest-store';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../../cli/adapters/acp-cli-adapter.test-helpers';
import type { AcpJsonRpcRequest, AcpSessionPromptParams } from '../../../shared/types/cli.types';
import { SYSTEM_PROMPT_BLOCK_SEPARATOR } from '../../context/prompt-injection-contract';
import { HARNESS_GUIDE } from '../../orchestration/harness-guidance';
import { CLAUDE_HELPER_REVIEWER_RULE } from '../../cli/adapters/claude-subagent-policy';
import { getOutputStyleRegistry } from '../output-style-registry';

const mocks = vi.hoisted(() => ({
  resolveAgent: vi.fn(),
  resolveInstructionStack: vi.fn(),
  loadProjectRules: vi.fn(),
  supervisorRegister: vi.fn(() => ({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' })),
  supervisorUnregister: vi.fn(),
  outputStorageDelete: vi.fn().mockResolvedValue(undefined),
  createAdapter: vi.fn(),
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  promptHistoryRecord: vi.fn(),
  promptHistoryClear: vi.fn(),
  maybeGenerateTitle: vi.fn().mockResolvedValue(undefined),
  localModelInventory: [] as unknown[],
  localModelRefresh: vi.fn(),
  getProviderCapabilities: vi.fn(),
  buildProjectMemoryBrief: vi.fn(),
  extractAuthoredLessons: vi.fn(),
  outputStyle: 'default' as string,
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aio-test', isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({ get: vi.fn(), set: vi.fn(), store: {} })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      defaultYoloMode: false,
      defaultCli: 'claude',
      outputStyle: mocks.outputStyle,
      injectRepoMap: false,
      residentClaudeSession: true,
    }),
    get: vi.fn(),
    on: vi.fn(),
  }),
}));

vi.mock('../../memory', () => ({
  getOutputStorageManager: () => ({
    deleteInstance: mocks.outputStorageDelete,
    loadMessages: vi.fn().mockResolvedValue([]),
    getTotalStats: vi.fn(() => ({})),
  }),
  getMemoryMonitor: () => ({ on: vi.fn(), start: vi.fn(), stop: vi.fn() }),
  getUnifiedMemory: () => ({}),
}));

vi.mock('../../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    deleteInstance: mocks.outputStorageDelete,
    loadMessages: vi.fn().mockResolvedValue([]),
    getTotalStats: vi.fn(() => ({})),
  }),
}));

vi.mock('../../process', () => ({
  getSupervisorTree: () => ({
    registerInstance: mocks.supervisorRegister,
    unregisterInstance: mocks.supervisorUnregister,
  }),
}));

vi.mock('../../process/hibernation-manager', () => ({
  getHibernationManager: () => ({ markHibernated: vi.fn(), markAwoken: vi.fn() }),
}));

vi.mock('../../history', () => ({
  getHistoryManager: () => ({ archiveInstance: vi.fn() }),
}));

vi.mock('../../agents/agent-registry', () => ({
  getAgentRegistry: () => ({ resolveAgent: mocks.resolveAgent }),
}));

vi.mock('../../security/permission-manager', () => ({
  getPermissionManager: () => ({ loadProjectRules: mocks.loadProjectRules }),
}));

vi.mock('../../core/config/instruction-resolver', () => ({
  resolveInstructionStack: mocks.resolveInstructionStack,
}));

vi.mock('../context-worker-client', () => ({
  getContextWorkerClient: () => ({
    buildProjectMemoryBrief: mocks.buildProjectMemoryBrief,
  }),
}));

vi.mock('../../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: () => ({ buildBrief: vi.fn() }),
}));

vi.mock('../../memory/project-story-convention', () => ({
  extractAuthoredLessons: mocks.extractAuthoredLessons,
}));

vi.mock('../../memory/project-knowledge-coordinator', () => ({
  getProjectKnowledgeCoordinator: () => ({
    ensureProjectKnown: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../memory/conversation-miner', () => ({
  getConversationMiner: () => ({ importFromString: vi.fn() }),
}));

vi.mock('../../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    exportRuntimeToolContextSnapshot: vi.fn(() => ({ servers: [], tools: [] })),
    hydrateRuntimeToolContextSelection: vi.fn(),
    formatRuntimeToolContext: vi.fn(),
  }),
}));

vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: () => ({
    buildContext: vi.fn().mockResolvedValue(null),
    formatContextBlock: vi.fn(() => null),
  }),
}));

vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: mocks.resolveCliType,
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../lifecycle/create-validation-helpers', () => ({
  getKnownModelsForCli: vi.fn().mockResolvedValue([]),
  isRestoreOrReplayContinuity: vi.fn(() => false),
  requiresFreshConfiguredModelSpawn: vi.fn(() => false),
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({
    createAdapter: mocks.createAdapter,
    getCapabilities: mocks.getProviderCapabilities,
    getRuntimeSnapshot: () => undefined,
  }),
}));

vi.mock('../../providers/activity-state-detector', () => ({
  ActivityStateDetector: class {
    setPid(): void { /* stub */ }
  },
}));

vi.mock('../../prompt-history/prompt-history-service', () => ({
  getPromptHistoryService: () => ({
    record: mocks.promptHistoryRecord,
    clearForInstance: mocks.promptHistoryClear,
  }),
}));

vi.mock('../auto-title-service', () => ({
  getAutoTitleService: () => ({ maybeGenerateTitle: mocks.maybeGenerateTitle }),
}));

vi.mock('../../observability/lifecycle-trace', () => ({
  recordLifecycleTrace: vi.fn(),
}));

vi.mock('../../local-models/local-model-inventory-service', () => ({
  getLocalModelInventoryService: () => ({
    list: () => mocks.localModelInventory,
    refresh: mocks.localModelRefresh,
  }),
}));

vi.mock('../warm-codemem', () => ({
  warmCodememWithTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../codemem', () => ({
  getCodemem: () => ({}),
}));

vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: () => ({
    acquire: vi.fn().mockResolvedValue(() => undefined),
    forceRelease: vi.fn(),
  }),
}));

vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    resumeSession: vi.fn(),
    markNativeResumeFailed: vi.fn(),
    writeThroughIdentityLocked: vi.fn(),
  }),
}));

vi.mock('../../session/checkpoint-manager', () => ({
  getCheckpointManager: () => ({}),
}));

vi.mock('../../cli/hooks/defer-decision-store', () => ({
  getDeferDecisionStore: () => ({
    writeDecision: vi.fn(),
    getDecisionDir: () => '/tmp/aio-test/decisions',
  }),
}));

vi.mock('../../context/compaction-coordinator', () => ({
  getCompactionCoordinator: () => ({ resetBudgetTracker: vi.fn() }),
}));

vi.mock('../lifecycle/spawn-config-builder', () => ({
  SpawnConfigBuilder: class {
    getMcpConfig(): string[] { return []; }
    getChromeDevtoolsMcpOptions(): null { return null; }
    getBrowserGatewayMcpOptions(): null { return null; }
    getHarnessCliEnv(): undefined { return undefined; }
    getPermissionHookPath(): undefined { return undefined; }
    getRtkSpawnConfig(): undefined { return undefined; }
  },
}));

vi.mock('../lifecycle/runtime-readiness', () => ({
  RuntimeReadinessCoordinator: class {
    getAdapterRuntimeCapabilities(): { supportsResume: boolean; supportsForkSession: boolean } {
      return { supportsResume: false, supportsForkSession: false };
    }
    waitForResumeHealth(): Promise<boolean> { return Promise.resolve(true); }
    evaluateResumeHealth(): Promise<'healthy'> { return Promise.resolve('healthy'); }
    waitForAdapterWritable(): Promise<boolean> { return Promise.resolve(true); }
    waitForInputReadinessBoundary(): Promise<void> { return Promise.resolve(); }
  },
}));

vi.mock('../lifecycle/idle-monitor', () => ({
  IdleMonitor: class {
    start(): void { /* stub */ }
    stop(): void { /* stub */ }
    terminateIdleHalf(): Promise<void> { return Promise.resolve(); }
  },
}));

vi.mock('../lifecycle/memory-pressure-monitor', () => ({
  LifecycleMemoryPressureMonitor: class {
    start(): void { /* stub */ }
    stop(): void { /* stub */ }
    getStats(): Record<string, unknown> { return {}; }
  },
}));

import { InstanceLifecycleManager } from '../instance-lifecycle';
import { getDefaultAgent } from '../../../shared/types/agent.types';

interface FakeAdapter {
  spawn: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn<() => Promise<void>>>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  getName: () => string;
  getRuntimeCapabilities: () => {
    supportsResume: boolean;
    supportsForkSession: boolean;
    supportsNativeCompaction: boolean;
    supportsPermissionPrompts: boolean;
    supportsDeferPermission: boolean;
    selfManagedAutoCompaction: boolean;
  };
  on: ReturnType<typeof vi.fn>;
}

function makeFakeAdapter(): FakeAdapter {
  return {
    spawn: vi.fn().mockResolvedValue(4242),
    sendInput: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    getName: () => 'claude',
    getRuntimeCapabilities: () => ({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    }),
    on: vi.fn(),
  };
}

function makeHarness(overrides: Partial<LifecycleDependencies> = {}) {
  const instances = new Map<string, Instance>();
  const adapters = new Map<string, unknown>();
  const stateMachines = new Map<string, InstanceStateMachine>();

  const deps = {
    getInstance: (id: string) => instances.get(id),
    setInstance: (instance: Instance) => { instances.set(instance.id, instance); },
    deleteInstance: (id: string) => instances.delete(id),
    getAdapter: (id: string) => adapters.get(id),
    setAdapter: (id: string, adapter: unknown) => { adapters.set(id, adapter); },
    deleteAdapter: (id: string) => adapters.delete(id),
    getInstanceCount: () => instances.size,
    forEachInstance: (cb: (instance: Instance, id: string) => void) => {
      instances.forEach(cb);
    },
    queueUpdate: vi.fn(),
    serializeForIpc: (instance: Instance) => ({ id: instance.id }),
    setupAdapterEvents: vi.fn(),
    initializeRlm: vi.fn().mockResolvedValue(undefined),
    endRlmSession: vi.fn(),
    ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
    buildObservationContext: vi.fn().mockResolvedValue(''),
    buildWakeContextText: vi.fn().mockResolvedValue(null),
    buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
    registerOrchestration: vi.fn(),
    unregisterOrchestration: vi.fn(),
    markInterrupted: vi.fn(),
    clearInterrupted: vi.fn(),
    addToOutputBuffer: (instance: Instance, message: { id: string }) => {
      instance.outputBuffer.push(message as Instance['outputBuffer'][number]);
    },
    clearFirstMessageTracking: vi.fn(),
    markFirstMessageReceived: vi.fn(),
    deleteDiffTracker: vi.fn(),
    getStateMachine: (id: string) => stateMachines.get(id),
    setStateMachine: (id: string, machine: InstanceStateMachine) => {
      stateMachines.set(id, machine);
    },
    deleteStateMachine: (id: string) => { stateMachines.delete(id); },
    ...overrides,
  } as unknown as LifecycleDependencies;

  const manager = new InstanceLifecycleManager(deps);
  return { manager, deps, instances, adapters, stateMachines };
}

describe('instance-lifecycle system-prompt composition (WS-B4 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.outputStyle = 'default';
    mocks.resolveInstructionStack.mockResolvedValue({ sources: [], mergedContent: '' });
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    });
    mocks.buildProjectMemoryBrief.mockResolvedValue({
      text: '',
      stats: { projectKey: 'test', candidatesScanned: 0, candidatesIncluded: 0, truncated: false },
      sources: [],
    });
    mocks.extractAuthoredLessons.mockReturnValue(null);
    mocks.resolveInstructionStack.mockResolvedValue({ sources: [], mergedContent: null });
  });

  it('loads applicable instructions before spawning a restored session', async () => {
    const harness = makeHarness();
    try {
      const adapter = makeFakeAdapter();
      mocks.createAdapter.mockReturnValue(adapter);

      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project',
        provider: 'claude',
        isRestoredSession: true,
        resume: true,
        sessionId: 'restored-session',
      });
      await instance.readyPromise;

      expect(mocks.resolveInstructionStack).toHaveBeenCalledExactlyOnceWith({
        workingDirectory: '/tmp/project',
        discovery: 'applicable',
      });
      expect(adapter.spawn).toHaveBeenCalledOnce();
      expect(instance.status).toBe('idle');
    } finally {
      harness.manager.destroy();
    }
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('assembles instructions + tool-permissions in contract order with no optional blocks populated', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const agent = getDefaultAgent();

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;

    const expected = [
      agent.systemPrompt,
      buildToolPermissionPrompt(instance.yoloMode),
      CLAUDE_HELPER_REVIEWER_RULE,
      HARNESS_GUIDE,
    ].join(SYSTEM_PROMPT_BLOCK_SEPARATOR);

    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ systemPrompt: expected }),
      }),
    );
  });

  it('assembles instructions + output-style + observation-memory + project-brief + lessons + tool-permissions in contract order', async () => {
    const harness = makeHarness({
      buildObservationContext: vi.fn().mockResolvedValue('Past reflection: prefer const bindings.'),
    } as Partial<LifecycleDependencies>);
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    mocks.outputStyle = 'concise';
    mocks.buildProjectMemoryBrief.mockResolvedValue({
      text: 'Project: ai-orchestrator. Electron + Angular desktop app.',
      stats: { projectKey: 'test', candidatesScanned: 3, candidatesIncluded: 2, truncated: false },
      sources: [],
    });
    mocks.extractAuthoredLessons.mockReturnValue('## Lessons\n- Always run tsc --noEmit before claiming done.');
    const agent = getDefaultAgent();

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      initialPrompt: 'Review binding conventions in this project.',
    });
    await instance.readyPromise;

    const expected = [
      agent.systemPrompt,
      'Output style — Concise: minimize prose. Prefer short, direct answers, bullet points, and code over explanation. Skip pleasantries and do not restate the question. Lead with the answer.',
      'Past reflection: prefer const bindings.',
      'Project: ai-orchestrator. Electron + Angular desktop app.',
      '## Lessons\n- Always run tsc --noEmit before claiming done.',
      buildToolPermissionPrompt(instance.yoloMode),
      CLAUDE_HELPER_REVIEWER_RULE,
      HARNESS_GUIDE,
    ].join(SYSTEM_PROMPT_BLOCK_SEPARATOR);

    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ systemPrompt: expected }),
      }),
    );
  });

  it.each([
    { requested: 'auto', resolved: 'claude', delivered: true },
    { requested: undefined, resolved: 'claude', delivered: true },
    { requested: 'auto', resolved: 'codex', delivered: false },
  ])('gives the Claude helper rule to the resolved CLI ($requested resolving to $resolved)', async ({ requested, resolved, delivered }) => {
    const harness = makeHarness();
    try {
      mocks.resolveCliType.mockResolvedValue(resolved);
      mocks.createAdapter.mockReturnValue(makeFakeAdapter());
      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project', provider: requested as Instance['provider'] | undefined,
      });
      await instance.readyPromise;
      const systemPrompt = mocks.createAdapter.mock.calls[0][0].options.systemPrompt as string;
      expect(systemPrompt.includes(CLAUDE_HELPER_REVIEWER_RULE)).toBe(delivered);
    } finally {
      harness.manager.destroy();
    }
  });

  it.each([
    { requested: 'auto', resolved: 'codex', omitted: 'PROJECT_AGENTS', retained: 'PROJECT_CLAUDE' },
    { requested: 'auto', resolved: 'claude', omitted: 'PROJECT_CLAUDE', retained: 'PROJECT_AGENTS' },
    { requested: 'codex', resolved: 'claude', omitted: 'PROJECT_CLAUDE', retained: 'PROJECT_AGENTS' },
  ])('applies native instruction ownership for $requested resolving to $resolved', async ({ requested, resolved, omitted, retained }) => {
    const harness = makeHarness();
    try {
      mocks.resolveCliType.mockResolvedValue(resolved);
      mocks.resolveInstructionStack.mockResolvedValue({
        mergedContent: ['GLOBAL_AIO', 'PROJECT_CLAUDE', 'PROJECT_AGENTS'].join('\n\n---\n\n'),
        sources: [
          { path: '/global/INSTRUCTIONS.md', kind: 'orchestrator', scope: 'user', loaded: true, applied: true, priority: 0, label: 'Global AIO' },
          { path: '/tmp/project/CLAUDE.md', kind: 'claude', scope: 'project', loaded: true, applied: true, priority: 1, label: 'Claude' },
          { path: '/tmp/project/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true, priority: 2, label: 'Agents' },
        ],
      });
      mocks.createAdapter.mockReturnValue(makeFakeAdapter());
      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project', provider: requested as Instance['provider'],
      });
      await instance.readyPromise;
      const systemPrompt = mocks.createAdapter.mock.calls[0][0].options.systemPrompt as string;
      expect(systemPrompt).toContain('GLOBAL_AIO');
      expect(systemPrompt).toContain(retained);
      expect(systemPrompt).not.toContain(omitted);
      expect(instance.provider).toBe(resolved);
    } finally {
      harness.manager.destroy();
    }
  });
  it('delivers global rules, mode instructions and permissions to an OpenCode root without duplicate AGENTS text', async () => {
    const globalRules = '# Global rules\n' + 'Read before editing. '.repeat(1200);
    const nativeProjectRules = 'NATIVE_AGENTS_SENTINEL';
    mocks.resolveInstructionStack.mockResolvedValue({
      mergedContent: `${globalRules}${SYSTEM_PROMPT_BLOCK_SEPARATOR}${nativeProjectRules}`,
      sources: [
        { path: '/home/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true, label: 'Global rules' },
        { path: '/tmp/project/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true, label: 'Project rules' },
      ],
    });
    const agent = { ...getDefaultAgent(), systemPrompt: 'Harness mode: plan changes with read-only access.' };
    mocks.resolveAgent.mockResolvedValue(agent);
    mocks.resolveCliType.mockResolvedValue('opencode');
    const proc = createInitializedAgentHarness();
    proc.onRequest('session/prompt', (message) => proc.respond(message.id, { stopReason: 'end_turn' }));
    mocks.createAdapter.mockImplementation((input) => new TestAcpCliAdapter(proc, {
      adapterName: 'opencode-acp', workingDirectory: '/tmp/project', systemPrompt: input.options.systemPrompt,
    }));
    try {
      const harness = makeHarness();
      const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'opencode' });
      await instance.readyPromise;
      const adapter = harness.adapters.get(instance.id) as TestAcpCliAdapter;
      await adapter.sendMessage({ role: 'user', content: 'Plan a fix.' });
      const firstPrompt = proc.receivedMessages.find((message): message is AcpJsonRpcRequest<AcpSessionPromptParams> =>
        'method' in message && message.method === 'session/prompt')!.params!.prompt;
      const instructions = firstPrompt[0];
      const expected = [globalRules, agent.systemPrompt, buildToolPermissionPrompt(instance.yoloMode), HARNESS_GUIDE].join(SYSTEM_PROMPT_BLOCK_SEPARATOR);
      expect(instructions).toEqual({ type: 'text', text: `[SYSTEM INSTRUCTIONS]\n${expected}\n[/SYSTEM INSTRUCTIONS]` });
      expect(JSON.stringify(firstPrompt)).not.toContain(nativeProjectRules);
      expect(getLatestContextManifest(instance.id)?.entries.find((entry) => entry.kind === 'instructions')).toMatchObject({ status: 'supplied', charLength: globalRules.length + agent.systemPrompt.length + SYSTEM_PROMPT_BLOCK_SEPARATOR.length });
      expect(getLatestContextManifest(instance.id)?.note).toBeUndefined();
    } finally { proc.exit(); }
  });

  it.each(['forced', 'selected', 'local'] as const)('uses resolved %s Codex placement for native paragraph ownership before assembly', async placement => {
    const shared = 'Shared governing Harness rule: preserve every user constraint.';
    const unique = 'Harness-specific governing rule: verify before claiming completion.';
    const global = `# Shared rules\n\n${shared}\n\n# Harness rules\n\n${unique}`;
    const nativeReads: string[] = [];
    // The resolver uses guarded CommonJS loading. Stub only that external
    // registry seam, keeping the real placement resolver and lifecycle intact.
    const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
    const originalLoad = loader._load;
    const node = { id: 'windows-pc', status: 'connected' };
    const registry = { getNode: vi.fn(() => node), selectNode: vi.fn(() => node) };
    vi.spyOn(loader, '_load').mockImplementation((request, ...args) => request === '../../remote-node'
      ? { getWorkerNodeRegistry: () => registry } : originalLoad.call(Module, request, ...args));
    mocks.resolveInstructionStack.mockResolvedValue({ mergedContent: global, sources: [
      { path: '/fixture/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true, label: 'Global rules' },
    ] });
    mocks.resolveCliType.mockResolvedValue('codex');
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const harness = makeHarness();
    const ownership = await import('../../core/config/native-instruction-ownership');
    const realOmit = ownership.omitNativeOwnedInstructionStack;
    // Replace only the file-reader seam below the real ownership algorithm;
    // no native instruction/profile data is read by this regression.
    vi.spyOn(ownership, 'omitNativeOwnedInstructionStack').mockImplementation((resolution, provider, _reader, home, options) =>
      realOmit(resolution, provider, file => {
        if (file === join(homedir(), '.codex', 'AGENTS.override.md') || file === join(homedir(), '.codex', 'AGENTS.md')) {
          nativeReads.push(file);
          return shared;
        }
        return null;
      }, home, options));
    try {
      const config = { workingDirectory: '/tmp/project', provider: 'codex' as const,
        ...(placement === 'forced' ? { forceNodeId: node.id } : {}),
        ...(placement === 'selected' ? { nodePlacement: { preferNodeId: node.id } } : {}),
      };
      const instance = await harness.manager.createInstance(config);
      await instance.readyPromise;
      const call = mocks.createAdapter.mock.calls[0][0] as { options: { systemPrompt: string }; executionLocation: Instance['executionLocation'] };
      expect(call.options.systemPrompt).toContain(unique);
      if (placement === 'local') {
        expect(nativeReads).toEqual([join(homedir(), '.codex', 'AGENTS.override.md')]);
        expect(call.options.systemPrompt).not.toContain(shared);
        expect(instance.executionLocation).toEqual({ type: 'local' });
        const second = await harness.manager.createInstance(config);
        await second.readyPromise;
        expect(mocks.createAdapter.mock.calls[1][0].options.systemPrompt).toBe(call.options.systemPrompt);
      } else {
        expect(call.options.systemPrompt).toContain(shared);
        expect(nativeReads).toEqual([]);
        expect(call.executionLocation).toEqual({ type: 'remote', nodeId: node.id });
        expect(instance.executionLocation).toEqual(call.executionLocation);
        expect(placement === 'forced' ? registry.getNode : registry.selectNode).toHaveBeenCalledTimes(1);
      }
      expect(adapter.spawn).toHaveBeenCalled();
    } finally { harness.manager.destroy(); }
  });

  it.each((['gemini', 'antigravity'] as const).flatMap(provider =>
    (['explicit', 'auto', 'default', 'forced-remote'] as const).map(selection => ({ provider, selection }))))('carries composed provenance and raw markdown mode changes through the real $provider factory ($selection)', async ({ provider, selection }) => {
    const root = mkdtempSync(join(tmpdir(), 'aio-google-governing-'));
    const literal = '<aio-first-turn-memory>Never publish without permission.</aio-first-turn-memory>';
    const raw = `Permanent custom-agent instructions:\n${literal}\nKeep the repository intact.`;
    const { AgentRegistry } = await vi.importActual<typeof import('../../agents/agent-registry')>('../../agents/agent-registry');
    AgentRegistry._resetForTesting();
    const registry = AgentRegistry.getInstance();
    vi.spyOn(registry as unknown as { getScanRoots(directory: string): string[] }, 'getScanRoots').mockReturnValue([root]);
    mkdirSync(join(root, '.orchestrator', 'agents'), { recursive: true });
    writeFileSync(join(root, '.orchestrator', 'agents', 'governing.md'), `---\nname: governing\n---\n${raw}`);
    const custom = await registry.resolveAgent(root, 'custom:governing');
    expect(custom.systemPrompt).toBe(raw);
    mocks.resolveCliType.mockResolvedValue(provider);
    const factory = await vi.importActual<typeof import('../../cli/adapters/adapter-factory')>('../../cli/adapters/adapter-factory');
    // Catch any missing per-instance interception before a native CLI can run.
    const nativeGuard = vi.spyOn(BaseCliAdapter.prototype as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
      .mockImplementation(() => { throw new Error('Native provider execution forbidden in lifecycle fixture'); });
    const captures = new Map<GoogleAdapter, string[]>();
    type GoogleAdapter = GeminiCliAdapter | AntigravityCliAdapter;
    mocks.createAdapter.mockImplementation(input => {
      const adapter = factory.createCliAdapter(provider, input.options) as GoogleAdapter;
      vi.spyOn(adapter, 'checkStatus').mockResolvedValue({ available: true, authenticated: true });
      const prompts: string[] = [];
      captures.set(adapter, prompts);
      Object.defineProperty(adapter, 'spawnProcess', { configurable: true, value: vi.fn((args: string[]) => {
        prompts.push(args.at(-1)!);
        const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
        queueMicrotask(() => {
          child.stdout.write(provider === 'gemini' ? '{"type":"message","role":"assistant","content":"result"}\n' : 'result');
          child.stdout.end(); child.emit('close', 0);
        });
        return child as unknown as ChildProcess;
      }) });
      return adapter;
    });
    if (selection === 'forced-remote') {
      const loader = Module as unknown as { _load: (request: string, ...args: unknown[]) => unknown };
      const originalLoad = loader._load;
      vi.spyOn(loader, '_load').mockImplementation((request, ...args) => request === '../../remote-node'
        ? { getWorkerNodeRegistry: () => ({ getNode: () => ({ id: 'windows-pc', status: 'connected' }) }) }
        : originalLoad.call(Module, request, ...args));
    }
    const harness = makeHarness({ buildObservationContext: vi.fn().mockResolvedValue('Composer-owned observation advice') });
    try {
      const instance = await harness.manager.createInstance({ workingDirectory: root,
        ...(selection === 'default' ? {} : { provider: selection === 'auto' ? 'auto' : provider }),
        ...(selection === 'forced-remote' ? { forceNodeId: 'windows-pc' } : {}),
        initialPrompt: 'Review the requested project change' });
      await instance.readyPromise;
      expect(instance.provider).toBe(provider);
      expect(selection === 'forced-remote' ? mocks.resolveCliType.mock.calls.length === 0 : mocks.resolveCliType.mock.calls.length > 0).toBe(true);
      const initial = mocks.createAdapter.mock.calls[0][0].options;
      expect(initial.systemPrompt).toContain('Composer-owned observation advice');
      expect(initial.systemPromptAfterFirstTurn).not.toContain('Composer-owned observation advice');
      expect(initial.systemPromptAfterFirstTurn).toContain(buildToolPermissionPrompt(instance.yoloMode));
      mocks.resolveAgent.mockResolvedValue(custom);
      await harness.manager.changeAgentMode(instance.id, custom.id);
      const adapter = harness.adapters.get(instance.id) as GeminiCliAdapter | AntigravityCliAdapter;
      await adapter.sendMessage({ role: 'user', content: 'First custom-agent request' });
      await adapter.sendMessage({ role: 'user', content: 'Later custom-agent request' });
      // Mode change sends replay and mode instructions before these two explicit requests.
      expect(captures.get(adapter)).toHaveLength(4);
      for (const prompt of captures.get(adapter)!) expect(prompt).toContain(raw);
      expect(nativeGuard).not.toHaveBeenCalled();
      expect(mocks.createAdapter.mock.calls.at(-1)![0].options.systemPromptAfterFirstTurn).toBeUndefined();
    } finally {
      try { await Promise.all([...captures.keys()].map(adapter => adapter.terminate(false))); }
      finally { harness.manager.destroy(); AgentRegistry._resetForTesting(); rmSync(root, { recursive: true, force: true }); }
    }
  });

  it.each((['claude', 'gemini'] as const).flatMap(cliHint =>
    (['ollama', 'openai-compatible'] as const).flatMap(endpointProvider =>
      (['this-device', 'worker-node'] as const).map(source => ({ cliHint, endpointProvider, source })))))('keeps HTTP $endpointProvider governing instructions on $source when CLI hint resolves to $cliHint', async ({ cliHint, endpointProvider, source }) => {
    const refuseNetwork = (): never => { throw new Error('Native HTTP service execution forbidden in local-target fixture'); };
    const networkGuards = [
      vi.spyOn(http, 'get').mockImplementation(refuseNetwork),
      vi.spyOn(http, 'request').mockImplementation(refuseNetwork),
      vi.spyOn(https, 'get').mockImplementation(refuseNetwork),
      vi.spyOn(https, 'request').mockImplementation(refuseNetwork),
    ];
    const fetchGuard = vi.fn(refuseNetwork);
    vi.stubGlobal('fetch', fetchGuard);
    const nativeGuard = vi.spyOn(BaseCliAdapter.prototype as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
      .mockImplementation(() => { throw new Error('Native CLI execution forbidden in local-target fixture'); });
    const clauses = [
      'Never publish private customer records. Obtain permission before external actions.',
      'GEMINI project rule: preserve the exact customer constraint.',
      'AGENTS project rule: verify the requested result.',
    ];
    mocks.resolveInstructionStack.mockResolvedValue({ mergedContent: clauses.join(SYSTEM_PROMPT_BLOCK_SEPARATOR), sources: [
      { path: '/synthetic/.claude/CLAUDE.md', kind: 'claude', scope: 'user', loaded: true, applied: true, label: 'Global rules' },
      { path: '/synthetic/project/GEMINI.md', kind: 'gemini', scope: 'project', loaded: true, applied: true, label: 'Project Gemini rules' },
      { path: '/synthetic/project/AGENTS.md', kind: 'agents', scope: 'project', loaded: true, applied: true, label: 'Project agent rules' },
    ] });
    mocks.resolveCliType.mockResolvedValue(cliHint);
    const target: Extract<ModelRuntimeTarget, { kind: 'local-model' }> = {
      kind: 'local-model', source, endpointProvider, endpointId: 'synthetic-endpoint', modelId: 'synthetic-model',
      selectorId: encodeLocalModelSelector({ source, endpointProvider, endpointId: 'synthetic-endpoint', modelId: 'synthetic-model',
        ...(source === 'worker-node' ? { nodeId: 'windows-pc' } : {}) }),
      ...(source === 'worker-node' ? { nodeId: 'windows-pc' } : {}),
    };
    mocks.localModelInventory.push({ ...target, healthy: true });
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const harness = makeHarness({ buildObservationContext: vi.fn().mockResolvedValue('HTTP model keeps first-turn memory in its conversation') });
    try {
      const instance = await harness.manager.createInstance({ workingDirectory: '/synthetic/project', provider: 'auto', modelRuntimeTarget: target,
        initialPrompt: 'Check governing instructions' });
      await instance.readyPromise;
      const call = mocks.createAdapter.mock.calls[0][0];
      expect(call.options.modelRuntimeTarget).toEqual(target);
      expect(call.executionLocation).toEqual(source === 'worker-node' ? { type: 'remote', nodeId: 'windows-pc' } : { type: 'local' });
      expect(call.options.model).toBe(target.modelId);
      for (const clause of clauses) expect(call.options.systemPrompt).toContain(clause);
      expect(call.options.systemPrompt).toContain('HTTP model keeps first-turn memory');
      expect(call.options.systemPromptAfterFirstTurn).toBeUndefined();
      expect(adapter.spawn).toHaveBeenCalledOnce();
      expect(adapter.sendInput).toHaveBeenCalled();
      expect(nativeGuard).not.toHaveBeenCalled();
      expect(fetchGuard).not.toHaveBeenCalled();
      for (const guard of networkGuards) expect(guard).not.toHaveBeenCalled();
    } finally {
      try { await adapter.terminate(); }
      finally { harness.manager.destroy(); vi.unstubAllGlobals(); }
    }
  });

  // Style handling reads only the requested provider; the resolved profile changes only
  // the prompt pair (gemini, antigravity) and the local-model route. So: every profile on
  // `auto` and every CLI profile on `explicit` with the strongest style (user-replace),
  // one `default` row, and the other two style branches (built-in, user append), one of
  // them on a two-prompt profile.
  it.each<{
    profile: 'ollama' | 'openai-compatible' | 'antigravity' | 'opencode' | 'grok' | 'claude' | 'gemini';
    selection: 'auto' | 'default' | 'explicit';
    style: 'concise' | 'user-append' | 'user-replace';
  }>([
    { profile: 'ollama', selection: 'auto', style: 'user-replace' },
    { profile: 'openai-compatible', selection: 'auto', style: 'user-replace' },
    { profile: 'antigravity', selection: 'auto', style: 'user-replace' },
    { profile: 'opencode', selection: 'auto', style: 'user-replace' },
    { profile: 'grok', selection: 'auto', style: 'user-replace' },
    { profile: 'claude', selection: 'auto', style: 'user-replace' },
    { profile: 'gemini', selection: 'auto', style: 'user-replace' },
    { profile: 'antigravity', selection: 'explicit', style: 'user-replace' },
    { profile: 'opencode', selection: 'explicit', style: 'user-replace' },
    { profile: 'grok', selection: 'explicit', style: 'user-replace' },
    { profile: 'claude', selection: 'explicit', style: 'user-replace' },
    { profile: 'gemini', selection: 'explicit', style: 'user-replace' },
    { profile: 'claude', selection: 'default', style: 'user-replace' },
    { profile: 'claude', selection: 'auto', style: 'concise' },
    { profile: 'claude', selection: 'auto', style: 'user-append' },
    { profile: 'gemini', selection: 'auto', style: 'user-append' },
  ])(
    'preserves requested $selection style policy ($style) and brief metadata on resolved $profile', async ({ profile, selection, style }) => {
      const refuseNetwork = (): never => { throw new Error('HTTP execution forbidden in output-style fixture'); };
      const networkGuards = [vi.spyOn(http, 'get').mockImplementation(refuseNetwork), vi.spyOn(http, 'request').mockImplementation(refuseNetwork),
        vi.spyOn(https, 'get').mockImplementation(refuseNetwork), vi.spyOn(https, 'request').mockImplementation(refuseNetwork)];
      const fetchGuard = vi.fn(refuseNetwork);
      vi.stubGlobal('fetch', fetchGuard);
      const nativeGuard = vi.spyOn(BaseCliAdapter.prototype as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess')
        .mockImplementation(() => { throw new Error('Native CLI execution forbidden in output-style fixture'); });
      const userDirective = 'Use the requested synthetic communication style.';
      const userStyleResolver = vi.spyOn(getOutputStyleRegistry(), 'resolveUserStyle').mockResolvedValue({
        name: style, label: 'Synthetic style', directive: userDirective,
        mode: style === 'user-replace' ? 'replace' : 'append', source: 'user', filePath: '/synthetic/style.md',
      });
      mocks.outputStyle = style;
      const endpointProvider = profile === 'ollama' || profile === 'openai-compatible' ? profile : undefined;
      const target: Extract<ModelRuntimeTarget, { kind: 'local-model' }> | undefined = endpointProvider ? {
        kind: 'local-model', source: 'this-device', endpointProvider, endpointId: 'synthetic-endpoint', modelId: 'synthetic-model',
        selectorId: encodeLocalModelSelector({ source: 'this-device', endpointProvider, endpointId: 'synthetic-endpoint', modelId: 'synthetic-model' }),
      } : undefined;
      if (target) mocks.localModelInventory.push({ ...target, healthy: true });
      const requestedProvider = selection === 'auto' ? 'auto'
        : selection === 'explicit' && profile !== 'ollama' && profile !== 'openai-compatible' ? profile : undefined;
      mocks.resolveCliType.mockResolvedValue(endpointProvider ? 'claude' : profile);
      const governing = 'Permanent synthetic governing instruction: obtain permission before publishing.';
      mocks.resolveAgent.mockResolvedValue({ ...getDefaultAgent(), systemPrompt: governing });
      const adapter = makeFakeAdapter();
      mocks.createAdapter.mockReturnValue(adapter);
      const harness = makeHarness({ buildObservationContext: vi.fn().mockResolvedValue('Composer-owned synthetic advice') });
      try {
        const instance = await harness.manager.createInstance({ workingDirectory: '/synthetic/style-project',
          ...(requestedProvider === undefined ? {} : { provider: requestedProvider }),
          ...(target ? { modelRuntimeTarget: target } : {}), initialPrompt: 'Check the selected communication style' });
        await instance.readyPromise;
        const options = mocks.createAdapter.mock.calls[0][0].options;
        const styleAllowed = selection !== 'explicit' || profile === 'claude' || profile === 'gemini';
        const directive = style === 'concise' ? 'Output style — Concise:' : userDirective;
        const prompts: string[] = [options.systemPrompt];
        if (profile === 'gemini' || profile === 'antigravity') {
          expect(options.systemPromptAfterFirstTurn).toEqual(expect.any(String));
          expect(options.systemPromptAfterFirstTurn).not.toContain('Composer-owned synthetic advice');
          prompts.push(options.systemPromptAfterFirstTurn);
        } else expect(options.systemPromptAfterFirstTurn).toBeUndefined();
        for (const prompt of prompts) {
          expect(prompt.includes(directive)).toBe(styleAllowed);
          expect(prompt.includes(governing)).toBe(!(styleAllowed && style === 'user-replace'));
          expect(prompt).toContain(buildToolPermissionPrompt(instance.yoloMode));
        }
        expect(options.systemPrompt).toContain('Composer-owned synthetic advice');
        expect(options.modelRuntimeTarget).toEqual(target);
        expect(mocks.buildProjectMemoryBrief).toHaveBeenCalledWith(expect.objectContaining({ provider: requestedProvider }));
        expect(userStyleResolver).toHaveBeenCalledTimes(styleAllowed && style !== 'concise' ? 1 : 0);
        expect(adapter.sendInput).toHaveBeenCalled();
        expect(nativeGuard).not.toHaveBeenCalled();
        expect(fetchGuard).not.toHaveBeenCalled();
        for (const guard of networkGuards) expect(guard).not.toHaveBeenCalled();
      } finally {
        try { await adapter.terminate(); }
        finally { harness.manager.destroy(); vi.unstubAllGlobals(); }
      }
    });
});
