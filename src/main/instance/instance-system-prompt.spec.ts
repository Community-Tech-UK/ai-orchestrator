/**
 * WS-C6 regression: `assembleInstanceSystemPrompt` must record a context
 * manifest epoch for every assembly, with the right trigger ('spawn' for a
 * genuinely fresh session, 'respawn' for continuity revival/restore/fork —
 * see `isRestoreOrReplayContinuity`), the composer's real manifest folded
 * into every SYSTEM_PROMPT_BLOCK_ORDER kind, and no leaked content/paths.
 *
 * Lighter-weight than instance-lifecycle-system-prompt-contract.spec.ts:
 * calls the exported function directly instead of going through
 * InstanceLifecycleManager.createInstance()'s full spawn machinery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { AgentProfile } from '../../shared/types/agent.types';
import { SYSTEM_PROMPT_BLOCK_ORDER } from '../context/prompt-injection-contract';
import {
  _resetAllContextManifestsForTesting,
  getContextManifestHistory,
} from '../context/context-manifest-store';

const promptMocks = vi.hoisted(() => ({
  indexedBuildContext: vi.fn().mockResolvedValue(null),
  queryReflections: vi.fn().mockResolvedValue([]),
  recordInjection: vi.fn().mockResolvedValue(undefined),
  logInfo: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: promptMocks.logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../observation/observation-store', () => ({
  getObservationStore: () => ({
    queryRelevantReflections: promptMocks.queryReflections,
    recordInjection: promptMocks.recordInjection,
  }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      outputStyle: 'default',
      injectRepoMap: false,
    }),
  }),
}));

vi.mock('../cli/cli-detection', () => ({
  getCliDetectionService: () => ({ peekCachedResult: () => null }),
}));

vi.mock('../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    exportRuntimeToolContextSnapshot: () => ({ servers: [], tools: [] }),
    hydrateRuntimeToolContextSelection: vi.fn(),
    formatRuntimeToolContext: vi.fn(),
  }),
}));

vi.mock('./context-worker-client', () => ({
  getContextWorkerClient: () => ({ buildProjectMemoryBrief: vi.fn() }),
}));

vi.mock('../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: () => ({ buildBrief: vi.fn() }),
}));

vi.mock('../memory/project-story-convention', () => ({
  extractAuthoredLessons: vi.fn(() => null),
}));

vi.mock('../memory/project-knowledge-coordinator', () => ({
  getProjectKnowledgeCoordinator: () => ({ ensureProjectKnown: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock('../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: () => ({
    buildContext: promptMocks.indexedBuildContext,
    formatContextBlock: vi.fn(() => null),
  }),
}));

import { PolicyAdapter } from '../observation/policy-adapter';
import { buildClaudeCliArgs } from '../cli/adapters/claude-cli-argv-builder';
import { claudePolicyExposure } from '../cli/adapters/claude-policy-exposure';
import { CLAUDE_HELPER_REVIEWER_RULE } from '../cli/adapters/claude-subagent-policy';
import { HARNESS_GUIDE } from '../orchestration/harness-guidance';
import type { Reflection } from '../observation/observation.types';

import { assembleInstanceSystemPrompt } from './instance-system-prompt';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    depth: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    ...overrides,
  } as Instance;
}

function makeDeps() {
  return {
    buildObservationContext: vi.fn().mockResolvedValue(''),
    buildWakeContextText: vi.fn().mockResolvedValue(null),
    buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
    deferEnricherPreamble: vi.fn(),
  };
}

const baseAgent: AgentProfile = { systemPrompt: 'You are a helpful agent.' } as AgentProfile;

describe('assembleInstanceSystemPrompt context manifest capture (WS-C6)', () => {
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
    promptMocks.indexedBuildContext.mockClear();
    promptMocks.indexedBuildContext.mockResolvedValue(null);
  });

  it.each(['codex', 'claude'] as const)('leaves resolved-provider background instructions to runtime binding (%s)', async (provider) => {
    const result = await assembleInstanceSystemPrompt({
      resolvedProvider: provider === 'claude' ? 'claude' : 'codex',
      instance: makeInstance(), config: { workingDirectory: '/tmp/project', provider },
      resolvedAgent: baseAgent, instructionPrompts: [], initialUserMessageContent: undefined, deps: makeDeps(),
    });
    expect(result.systemPrompt).not.toContain('[Background commands]');
    expect(result.systemPrompt).toContain(baseAgent.systemPrompt);
  });

  it('bounds initial indexed store lookup by the create-enricher deadline', async () => {
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance: makeInstance(),
      config: { workingDirectory: '/tmp/project', provider: 'claude' },
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: 'find auth middleware',
      deps: makeDeps(),
    });

    expect(promptMocks.indexedBuildContext).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: '/tmp/project',
      query: 'find auth middleware',
      storeLookupDeadlineMs: 600,
    }));
  });

  it('records a spawn-trigger epoch with one entry per contract block kind for a fresh session', async () => {
    const instance = makeInstance();
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance,
      config: { workingDirectory: '/tmp/project', provider: 'claude' },
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: undefined,
      deps: makeDeps(),
    });

    const history = getContextManifestHistory('inst-1');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ epoch: 0, trigger: 'spawn' });
    expect(history[0].entries.map((entry) => entry.kind)).toEqual([...SYSTEM_PROMPT_BLOCK_ORDER]);

    const instructions = history[0].entries.find((entry) => entry.kind === 'instructions');
    expect(instructions?.status).toBe('supplied');
    expect(instructions?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(instructions?.charLength).toBe(baseAgent.systemPrompt!.length);
  });

  it('records a respawn-trigger epoch for continuity-revival/restore configs', async () => {
    const instance = makeInstance();
    const config: InstanceCreateConfig = {
      workingDirectory: '/tmp/project',
      provider: 'claude',
      isRestoredSession: true,
    };
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance,
      config,
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: undefined,
      deps: makeDeps(),
    });

    const history = getContextManifestHistory('inst-1');
    expect(history[0].trigger).toBe('respawn');
  });

  it('records a respawn-trigger epoch when isRestoreOrReplayContinuity is true via config.resume', async () => {
    const instance = makeInstance();
    const config: InstanceCreateConfig = {
      workingDirectory: '/tmp/project',
      provider: 'claude',
      resume: true,
    };
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance,
      config,
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: undefined,
      deps: makeDeps(),
    });

    expect(getContextManifestHistory('inst-1')[0].trigger).toBe('respawn');
  });

  it('advances the epoch counter across successive assemblies for the same instance', async () => {
    const instance = makeInstance();
    const config: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider: 'claude' };
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance, config, resolvedAgent: baseAgent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps: makeDeps(),
    });
    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance, config, resolvedAgent: baseAgent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps: makeDeps(),
    });

    const history = getContextManifestHistory('inst-1');
    expect(history.map((snapshot) => snapshot.epoch)).toEqual([0, 1]);
  });

  it('marks a block unavailable (not skipped-empty) when its build times out', async () => {
    const instance = makeInstance();
    const config: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider: 'claude' };
    const deps = makeDeps();
    // Never resolves within CREATE_ENRICHER_DEADLINE_MS (600ms) -> onTimeout fires.
    deps.buildWakeContextText = vi.fn(() => new Promise(() => { /* Simulate an enricher that never finishes. */ }));

    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance, config, resolvedAgent: baseAgent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps,
    });

    const wakeEntry = getContextManifestHistory('inst-1')[0].entries.find((entry) => entry.kind === 'wake-context');
    expect(wakeEntry?.status).toBe('unavailable');
  }, 2000);

  it('never leaks raw content or filesystem paths into recorded entries', async () => {
    const instance = makeInstance({ workingDirectory: '/Users/secret-person/private-project' });
    const config: InstanceCreateConfig = { workingDirectory: instance.workingDirectory, provider: 'claude' };
    const agent: AgentProfile = { systemPrompt: 'Secret system prompt text /Users/secret-person/private-project' } as AgentProfile;

    await assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance, config, resolvedAgent: agent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps: makeDeps(),
    });

    const serialized = JSON.stringify(getContextManifestHistory('inst-1'));
    expect(serialized).not.toContain('Secret system prompt text');
    expect(serialized).not.toContain('/Users/secret-person');
  });

  it('records the bounded memory actually supplied and removes only identical instruction copies', async () => {
    const deps = makeDeps();
    deps.buildObservationContext.mockResolvedValue('Relevant prior finding.\n'.repeat(500));
    deps.buildWakeContextText.mockResolvedValue('Outstanding request: finish the known fix before repeating research.');
    const result = await assembleInstanceSystemPrompt({
      resolvedProvider: 'codex',
      instance: makeInstance(),
      config: { workingDirectory: '/tmp/project', provider: 'codex', initialPrompt: 'Fix memory injection' },
      resolvedAgent: baseAgent,
      instructionPrompts: ['Shared governing instruction', 'Shared governing instruction', 'Distinct project instruction'],
      initialUserMessageContent: undefined,
      deps,
    });
    expect(result.systemPrompt.split('Shared governing instruction')).toHaveLength(2);
    expect(result.systemPrompt).toContain('Distinct project instruction');
    expect(result.systemPrompt).toContain('Outstanding request');
    const snapshot = getContextManifestHistory('inst-1')[0];
    expect(snapshot.note).toContain('observation-memory:');
    expect(snapshot.entries.find((entry) => entry.kind === 'observation-memory')!.charLength).toBeLessThanOrEqual(1_200);
    expect(snapshot.entries.filter((entry) => entry.status === 'supplied').map(({ status: _status, ...entry }) => entry)).toEqual(result.systemPromptManifest);
  });
});


describe('assembleInstanceSystemPrompt observation retrieval (MEM-4)', () => {
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
    PolicyAdapter._resetForTesting();
    promptMocks.queryReflections.mockReset().mockResolvedValue([]);
    promptMocks.recordInjection.mockClear();
    promptMocks.logInfo.mockClear();
  });

  async function assemble(initialPrompt?: string, deps = makeDeps()) {
    return assembleInstanceSystemPrompt({
      resolvedProvider: 'claude',
      instance: makeInstance(),
      config: { workingDirectory: '/tmp/project', provider: 'claude', initialPrompt },
      resolvedAgent: baseAgent,
      instructionPrompts: ['Instructions are not the user search query.'],
      initialUserMessageContent: initialPrompt,
      deps,
    });
  }

  it("queries observation memory with the user's first message and no task-type filter", async () => {
    const deps = makeDeps();
    await assemble('Fix auth middleware race conditions', deps);
    expect(deps.buildObservationContext).toHaveBeenCalledWith('Fix auth middleware race conditions', 'inst-1');
  });

  it('fills the observation block from a matching reflection when the session has a first message', async () => {
    const reflection: Reflection = {
      id: 'reflection-1', title: 'Auth middleware race', insight: 'Serialize refresh requests before retrying.',
      confidence: 0.9, applicability: ['auth', 'middleware'], patterns: [], observationIds: [],
      createdAt: 1, ttl: 100000, usageCount: 0, effectivenessScore: 0.8, promotedToProcedural: false,
    };
    promptMocks.queryReflections.mockResolvedValue([reflection]);
    const adapter = PolicyAdapter.getInstance();
    adapter.configure({ enabled: true });
    const deps = makeDeps();
    deps.buildObservationContext.mockImplementation((...args: Parameters<PolicyAdapter['buildObservationContext']>) => adapter.buildObservationContext(...args));

    const result = await assemble('Fix auth middleware race conditions', deps);
    expect(result.systemPrompt).toContain('**Auth middleware race**');
    expect(result.systemPrompt).toContain('Serialize refresh requests before retrying.');
    expect(getContextManifestHistory('inst-1')[0].entries.find((entry) => entry.kind === 'observation-memory')?.status).toBe('supplied');
    expect(promptMocks.queryReflections).toHaveBeenCalledWith('Fix auth middleware race conditions', expect.any(Object));
    expect(promptMocks.logInfo).toHaveBeenCalledWith('Injected observation memory context into system prompt', { noteCount: 1 });
  });

  it('injects nothing and never queries under the opt-out default', async () => {
    promptMocks.queryReflections.mockResolvedValue([{
      id: 'reflection-1', title: 'Auth middleware race', insight: 'Serialize refresh requests before retrying.',
      confidence: 0.9, applicability: ['auth', 'middleware'], patterns: [], observationIds: [],
      createdAt: 1, ttl: 100000, usageCount: 0, effectivenessScore: 0.8, promotedToProcedural: false,
    } satisfies Reflection]);
    const adapter = PolicyAdapter.getInstance();
    const deps = makeDeps();
    deps.buildObservationContext.mockImplementation((...args: Parameters<PolicyAdapter['buildObservationContext']>) => adapter.buildObservationContext(...args));

    const result = await assemble('Fix auth middleware race conditions', deps);
    expect(result.systemPrompt).not.toContain('**Auth middleware race**');
    expect(promptMocks.queryReflections).not.toHaveBeenCalled();
    expect(getContextManifestHistory('inst-1')[0].entries.find((entry) => entry.kind === 'observation-memory')?.status).toBe('skipped-empty');
  });

  it('uses the sanitized question for a long pasted first message', async () => {
    const deps = makeDeps();
    await assemble(`${'Pasted code context. '.repeat(40)}\nWhere should the auth refresh be serialized?`, deps);
    expect(deps.buildObservationContext).toHaveBeenCalledWith('Where should the auth refresh be serialized?', 'inst-1');
  });

  it.each([undefined, '   '])('skips the lookup when there is no first message (%s)', async (initialPrompt) => {
    const deps = makeDeps();
    await assemble(initialPrompt, deps);
    expect(deps.buildObservationContext).not.toHaveBeenCalled();
    expect(getContextManifestHistory('inst-1')[0].entries.find((entry) => entry.kind === 'observation-memory')?.status).toBe('skipped-empty');
  });
});


describe('claude-helper-rules block (A18, plan Step 2 item 5)', () => {
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
  });

  async function assemble(
    provider: InstanceCreateConfig['provider'],
    extra: { id?: string; resolvedProvider?: string } = {},
  ) {
    const config: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider };
    return assembleInstanceSystemPrompt({
      instance: makeInstance({ id: extra.id ?? 'inst-1' }),
      config,
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: undefined,
      deps: makeDeps(),
      ...(extra.resolvedProvider ? { resolvedProvider: extra.resolvedProvider } : {}),
    });
  }

  it('gives a Claude session the reviewer rule exactly once, as its own manifest block', async () => {
    const result = await assemble('claude');
    expect(result.systemPrompt.split(CLAUDE_HELPER_REVIEWER_RULE)).toHaveLength(2);
    const entry = result.systemPromptManifest.find((e) => e.kind === 'claude-helper-rules');
    expect(entry?.charLength).toBe(CLAUDE_HELPER_REVIEWER_RULE.length);
    expect(getContextManifestHistory('inst-1')[0].entries.find((e) => e.kind === 'claude-helper-rules')?.status)
      .toBe('supplied');
  });

  it('gives every Claude session identical rule text, so the cache write is shared', async () => {
    const first = await assemble('claude', { id: 'inst-a' });
    const second = await assemble('claude', { id: 'inst-b' });
    expect(first.systemPromptManifest.find((e) => e.kind === 'claude-helper-rules')?.contentHash)
      .toBe(second.systemPromptManifest.find((e) => e.kind === 'claude-helper-rules')?.contentHash);
  });

  it.each(['codex', 'gemini'] as const)('does not give a %s session the rule', async (provider) => {
    const result = await assemble(provider);
    expect(result.systemPrompt).not.toContain('helper agent to review');
    expect(result.systemPromptManifest.find((e) => e.kind === 'claude-helper-rules')).toBeUndefined();
    expect(getContextManifestHistory('inst-1')[0].entries.find((e) => e.kind === 'claude-helper-rules')?.status)
      .toBe('skipped-empty');
  });

  it.each([undefined, 'auto'] as const)(
    'follows the resolved provider when the request said %s',
    async (requested) => {
      const claude = await assemble(requested, { resolvedProvider: 'claude' });
      expect(claude.systemPrompt).toContain(CLAUDE_HELPER_REVIEWER_RULE);
      const codex = await assemble(requested, { id: 'inst-2', resolvedProvider: 'codex' });
      expect(codex.systemPrompt).not.toContain(CLAUDE_HELPER_REVIEWER_RULE);
    },
  );

  it('reaches the real Claude argv, so the exposure record says delivered', async () => {
    const claude = await assemble('claude');
    const args = buildClaudeCliArgs({
      spawnOptions: { systemPrompt: claude.systemPrompt },
      sessionId: 'session-a1',
      excludeDynamicSectionsSupported: null,
      cliVersion: null,
      disallowedToolsOverride: null,
      shouldUseNativeResume: false,
      shouldUsePermissionHook: false,
      materializeInlineJsonArg: (value: string) => value,
    });
    expect(claudePolicyExposure('session-a1', {}, {}, args).reviewerRuleDelivered).toBe(true);
  });

  it('does not report delivery for a session whose prompt lacks the rule', async () => {
    const codex = await assemble('codex');
    const args = buildClaudeCliArgs({
      spawnOptions: { systemPrompt: codex.systemPrompt },
      sessionId: 'session-a1',
      excludeDynamicSectionsSupported: null,
      cliVersion: null,
      disallowedToolsOverride: null,
      shouldUseNativeResume: false,
      shouldUsePermissionHook: false,
      materializeInlineJsonArg: (value: string) => value,
    });
    expect(claudePolicyExposure('session-a1', {}, {}, args).reviewerRuleDelivered).toBe(false);
  });
});

describe('harness-guide block (A12, plan Step 10 item 3)', () => {
  beforeEach(() => {
    _resetAllContextManifestsForTesting();
  });

  async function assemble(
    instanceOverrides: Partial<Instance> = {},
    configOverrides: Partial<InstanceCreateConfig> = {},
  ) {
    const config: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider: 'claude', ...configOverrides };
    return assembleInstanceSystemPrompt({
      instance: makeInstance(instanceOverrides),
      config,
      resolvedAgent: baseAgent,
      instructionPrompts: [],
      initialUserMessageContent: undefined,
      deps: makeDeps(),
    });
  }

  const entryOf = (result: Awaited<ReturnType<typeof assemble>>) =>
    result.systemPromptManifest.find((e) => e.kind === 'harness-guide');

  it('adds the Harness guide as the last block of a root chat', async () => {
    const result = await assemble();
    expect(result.systemPrompt.endsWith(HARNESS_GUIDE)).toBe(true);
    expect(result.systemPrompt.split(HARNESS_GUIDE)).toHaveLength(2);
    expect(entryOf(result)?.charLength).toBe(HARNESS_GUIDE.length);
    expect(result.systemPromptManifest.at(-1)?.kind).toBe('harness-guide');
    expect(getContextManifestHistory('inst-1')[0].entries.find((e) => e.kind === 'harness-guide')?.status)
      .toBe('supplied');
  });

  it.each([
    ['a child by depth alone', { depth: 1 }, {}],
    ['a child by parent alone', {}, { parentId: 'parent-1' }],
    ['an automation run', {}, { metadata: { automationId: 'auto-1' } }],
    ['a plan-queue root', {}, { metadata: { planQueueRunId: 'run-1' } }],
    ['a repo job', {}, { metadata: { spendPurpose: 'repo-job' } }],
    ['a reviewer', {}, { metadata: { spendPurpose: 'review', pingPongReviewer: true } }],
  ] as const)('omits it for %s', async (_name, instanceOverrides, configOverrides) => {
    const result = await assemble(instanceOverrides, configOverrides);
    expect(result.systemPrompt).not.toContain(HARNESS_GUIDE);
    expect(result.systemPrompt).not.toContain('## Harness commands');
    expect(entryOf(result)).toBeUndefined();
    expect(getContextManifestHistory('inst-1')[0].entries.find((e) => e.kind === 'harness-guide')?.status)
      .toBe('skipped-empty');
  });
});
