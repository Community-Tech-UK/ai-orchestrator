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
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      outputStyle: 'default',
      injectRepoMap: false,
    }),
  }),
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

  it('bounds initial indexed store lookup by the create-enricher deadline', async () => {
    await assembleInstanceSystemPrompt({
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
      instance, config, resolvedAgent: baseAgent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps: makeDeps(),
    });
    await assembleInstanceSystemPrompt({
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
    deps.buildWakeContextText = vi.fn(() => new Promise(() => {}));

    await assembleInstanceSystemPrompt({
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
      instance, config, resolvedAgent: agent, instructionPrompts: [],
      initialUserMessageContent: undefined, deps: makeDeps(),
    });

    const serialized = JSON.stringify(getContextManifestHistory('inst-1'));
    expect(serialized).not.toContain('Secret system prompt text');
    expect(serialized).not.toContain('/Users/secret-person');
  });
});
