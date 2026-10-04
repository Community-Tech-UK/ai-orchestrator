import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { createInstance, type Instance, type InstanceCreateConfig, type InstanceProvider } from '../../shared/types/instance.types';
import type { AgentToolPermissions } from '../../shared/types/agent.types';
import type {
  SideChatAuthorityPolicy,
  SideChatParentRef,
  SideChatProviderSelection,
} from '../../shared/types/side-chat.types';
import type { ChatProvider } from '../../shared/types/chat.types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import { ChatStore } from './chat-store';
import { SideChatLinkStore } from './side-chat-link-store';
import {
  SideChatAuthorityResolver,
  policyToAgentPermissions,
  providerCanEnforcePolicy,
} from './side-chat-authority';

class FakeInstanceManager {
  readonly creates: InstanceCreateConfig[] = [];
  private readonly instances = new Map<string, Instance>();

  create(config: InstanceCreateConfig): Instance {
    this.creates.push(config);
    const instance = createInstance(config);
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(id: string): Instance | undefined {
    return this.instances.get(id);
  }

  getAllInstances(): Instance[] {
    return [...this.instances.values()];
  }
}

const PARENT_REF: SideChatParentRef = { kind: 'chat', chatId: 'parent-1' };

const RESTRICTED_PERMISSIONS: AgentToolPermissions = {
  read: 'allow',
  write: 'deny',
  bash: 'deny',
  web: 'allow',
  task: 'deny',
};

const FULL_PERMISSIONS: AgentToolPermissions = {
  read: 'allow',
  write: 'allow',
  bash: 'allow',
  web: 'allow',
  task: 'allow',
};

function makeTarget(overrides: Partial<Extract<ModelRuntimeTarget, { kind: 'local-model' }>> = {}): ModelRuntimeTarget {
  return {
    kind: 'local-model',
    source: 'this-device',
    endpointProvider: 'ollama',
    endpointId: 'ollama-default',
    modelId: 'llama3',
    selectorId: 'sel-1',
    ...overrides,
  };
}

describe('provider matrix: create → persist → reload → runtime config', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function harness() {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const chatStore = new ChatStore(db);
    const linkStore = new SideChatLinkStore(db);
    const instanceManager = new FakeInstanceManager();
    chatStore.insert({
      id: 'parent-1', name: 'Parent', provider: 'codex',
      currentCwd: '/work', ledgerThreadId: 'thread-parent',
    });
    return { db, chatStore, linkStore, instanceManager };
  }

  const PROVIDERS: Array<{ selection: SideChatProviderSelection; expectedProvider: string; expectedInstanceProvider: string }> = [
    { selection: { provider: 'claude', model: 'opus', reasoning: 'high' }, expectedProvider: 'claude', expectedInstanceProvider: 'claude' },
    { selection: { provider: 'codex', model: 'gpt-5', reasoning: 'medium' }, expectedProvider: 'codex', expectedInstanceProvider: 'codex' },
    { selection: { provider: 'gemini', model: 'gemini-pro', reasoning: null }, expectedProvider: 'gemini', expectedInstanceProvider: 'gemini' },
    { selection: { provider: 'antigravity', model: null, reasoning: null }, expectedProvider: 'antigravity', expectedInstanceProvider: 'antigravity' },
    { selection: { provider: 'copilot', model: 'gpt-4o', reasoning: null }, expectedProvider: 'copilot', expectedInstanceProvider: 'copilot' },
    { selection: { provider: 'cursor', model: null, reasoning: null }, expectedProvider: 'cursor', expectedInstanceProvider: 'cursor' },
    { selection: { provider: 'grok', model: 'grok-4', reasoning: null }, expectedProvider: 'grok', expectedInstanceProvider: 'grok' },
    { selection: { provider: 'opencode', model: null, reasoning: null }, expectedProvider: 'opencode', expectedInstanceProvider: 'opencode' },
    {
      selection: {
        provider: 'local-model',
        model: 'llama3',
        reasoning: null,
        modelRuntimeTarget: makeTarget(),
      },
      expectedProvider: 'local-model',
      // local-model maps to 'auto' at the InstanceProvider level; the target
      // carries the actual routing.
      expectedInstanceProvider: 'auto',
    },
  ];

  for (const { selection, expectedProvider, expectedInstanceProvider } of PROVIDERS) {
    it(`round-trips ${selection.provider} through create → persist → reload → runtime config`, () => {
      const { chatStore, linkStore, instanceManager } = harness();
      // Create
      const chat = linkStore.insertWithBacker(
        {
          chatId: `side-${selection.provider}`,
          parent: PARENT_REF,
          authority: 'inherit-parent',
          lastReadAssistantSequence: 0,
        },
        () =>
          chatStore.insert({
            id: `side-${selection.provider}`,
            name: `Side ${selection.provider}`,
            provider: selection.provider as ChatProvider,
            model: selection.model ?? null,
            reasoningEffort: selection.reasoning ?? null,
            modelRuntimeTarget: selection.modelRuntimeTarget ?? null,
            currentCwd: '/work',
            ledgerThreadId: `thread-${selection.provider}`,
          }),
      );

      // Persist → reload
      const reloaded = chatStore.get(chat.id)!;
      expect(reloaded.provider).toBe(expectedProvider);
      expect(reloaded.model).toBe(selection.model ?? null);
      if (selection.modelRuntimeTarget) {
        expect(reloaded.modelRuntimeTarget).toEqual(selection.modelRuntimeTarget);
      }

      // Runtime config: spawn carries the selection through to createInstance
      const instance = instanceManager.create({
        workingDirectory: reloaded.currentCwd!,
        displayName: reloaded.name,
        provider: reloaded.provider === 'local-model' ? 'auto' : reloaded.provider as InstanceProvider,
        modelOverride: reloaded.model ?? undefined,
        modelRuntimeTarget: reloaded.modelRuntimeTarget ?? undefined,
        reasoningEffort: reloaded.reasoningEffort,
        agentId: 'build',
        historyThreadId: reloaded.ledgerThreadId,
      });
      const config = instanceManager.creates.at(-1)!;
      expect(config.provider).toBe(expectedInstanceProvider);
      if (selection.modelRuntimeTarget) {
        expect(config.modelRuntimeTarget).toEqual(selection.modelRuntimeTarget);
        // Local-model target metadata survives every seam.
        if (config.modelRuntimeTarget?.kind === 'local-model') {
          expect(config.modelRuntimeTarget.modelId).toBe('llama3');
          expect(config.modelRuntimeTarget.selectorId).toBe('sel-1');
        }
      }
      // No selected provider silently becomes Claude or null.
      // local-model legitimately maps to 'auto' (routing is via modelRuntimeTarget).
      if (selection.provider !== 'local-model' && selection.provider !== 'claude') {
        expect(instance.provider).not.toBe('auto');
        expect(instance.provider).not.toBe('claude');
      }
    });
  }

  it('preserves local-model target with node metadata through the full chain', () => {
    const { chatStore, linkStore, instanceManager } = harness();
    const target = makeTarget({ source: 'worker-node', nodeId: 'node-7', nodeName: 'windows-pc' });
    linkStore.insertWithBacker(
      { chatId: 'side-lm', parent: PARENT_REF, authority: 'inherit-parent', lastReadAssistantSequence: 0 },
      () =>
        chatStore.insert({
          id: 'side-lm', name: 'Local', provider: 'local-model',
          model: 'llama3', modelRuntimeTarget: target,
          currentCwd: '/work', ledgerThreadId: 'thread-lm',
        }),
    );
    const reloaded = chatStore.get('side-lm')!;
    expect(reloaded.modelRuntimeTarget).toEqual(target);
    instanceManager.create({
      workingDirectory: '/work', displayName: 'Local',
      provider: 'auto',
      modelRuntimeTarget: reloaded.modelRuntimeTarget ?? undefined,
      agentId: 'build', historyThreadId: 'thread-lm',
    });
    const config = instanceManager.creates.at(-1)!;
    expect(config.modelRuntimeTarget).toEqual(target);
    if (config.modelRuntimeTarget?.kind === 'local-model') {
      expect(config.modelRuntimeTarget.nodeId).toBe('node-7');
      expect(config.modelRuntimeTarget.nodeName).toBe('windows-pc');
    }
  });
});

describe('SideChatAuthorityResolver', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  function harness(options: {
    parentAgentId?: string;
    parentYolo?: boolean;
    parentHardened?: boolean;
    parentContained?: boolean;
    parentPresent?: boolean;
    persistedPolicy?: SideChatAuthorityPolicy | null;
  } = {}) {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const chatStore = new ChatStore(db);
    const instanceManager = new FakeInstanceManager();

    if (options.parentPresent !== false) {
      chatStore.insert({
        id: 'parent-1', name: 'Parent', provider: 'codex',
        currentCwd: '/work', ledgerThreadId: 'thread-parent',
      });
      const instance = instanceManager.create({
        workingDirectory: '/work', displayName: 'Parent', provider: 'codex',
        agentId: options.parentAgentId ?? 'build',
        yoloMode: options.parentYolo ?? false,
      });
      if (options.parentHardened) instance.hardened = true;
      if (options.parentContained) instance.containedExecution = true;
      instance.workerNodeId = 'node-parent';
      chatStore.update('parent-1', { currentInstanceId: instance.id });
    }

    const persisted = new Map<string, SideChatAuthorityPolicy>();
    const resolver = new SideChatAuthorityResolver({
      chatStore,
      instanceManager: instanceManager as never,
      loadPersistedPolicy: (parent) => {
        if (options.persistedPolicy !== undefined) return options.persistedPolicy;
        const key = parent.kind === 'chat' ? parent.chatId : parent.historyThreadId;
        return persisted.get(key) ?? null;
      },
      persistPolicy: (parent, policy) => {
        const key = parent.kind === 'chat' ? parent.chatId : parent.historyThreadId;
        persisted.set(key, policy);
      },
    });
    return { resolver, persisted, instanceManager, chatStore };
  }

  it('resolves live parent policy and persists it for runtime replacement', () => {
    const { resolver, persisted } = harness();
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('live-parent');
      expect(result.policy.agentToolPermissions).toEqual(FULL_PERMISSIONS);
    }
    expect(persisted.has('parent-1')).toBe(true);
  });

  it('inherits restricted parent permissions faithfully through policyToAgentPermissions', () => {
    const { resolver } = harness({ parentAgentId: 'plan' });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const translated = policyToAgentPermissions(result.policy);
      // The plan agent denies writes — translation must not broaden to allow.
      expect(translated.write).toBe('deny');
      expect(translated.read).toBe('allow');
    }
  });

  it('returns unavailable-permissions when parent is absent and no policy is persisted', () => {
    const { resolver } = harness({ parentPresent: false, persistedPolicy: null });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unavailable-permissions');
    }
  });

  it('uses a persisted policy when the parent is absent and preserves non-broadening', () => {
    const persisted = { ...makePolicyLike(), agentToolPermissions: RESTRICTED_PERMISSIONS };
    const { resolver } = harness({ parentPresent: false, persistedPolicy: persisted });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('persisted');
      const translated = policyToAgentPermissions(result.policy);
      // Non-broadening: write was 'deny' in the persisted policy and stays 'deny'.
      expect(translated.write).toBe('deny');
      expect(translated.bash).toBe('deny');
    }
  });

  it('returns an explicit unavailable-permissions error with descriptive text', () => {
    const { resolver } = harness({ parentPresent: false, persistedPolicy: null });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unavailable-permissions');
      expect(result.error).toContain('no verified permission policy');
      expect(result.error).toContain('Cannot authorise');
    }
  });

  it('resolves workspace node provenance from the parent instance', () => {
    const { resolver } = harness();
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.workspaceNode).toBe('node-parent');
    }
  });

  it('captures hardened and contained execution flags', () => {
    const { resolver } = harness({ parentHardened: true, parentContained: true });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.hardened).toBe(true);
      expect(result.policy.containedExecution).toBe(true);
    }
  });
});

describe('providerCanEnforcePolicy', () => {
  it('allows CLI providers for restricted parents', () => {
    const policy = makePolicyLike();
    policy.agentToolPermissions = RESTRICTED_PERMISSIONS;
    expect(providerCanEnforcePolicy('claude', policy).ok).toBe(true);
    expect(providerCanEnforcePolicy('codex', policy).ok).toBe(true);
  });

  it('rejects local-model for a restricted parent with a concrete capability failure', () => {
    const policy = makePolicyLike();
    policy.agentToolPermissions = RESTRICTED_PERMISSIONS;
    const result = providerCanEnforcePolicy('local-model', policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.capability).toContain('local-model');
      expect(result.capability).toContain('restrictions');
    }
  });

  it('rejects local-model when hardened or contained execution is required', () => {
    const hardened = makePolicyLike();
    hardened.hardened = true;
    expect(providerCanEnforcePolicy('local-model', hardened).ok).toBe(false);
    const contained = makePolicyLike();
    contained.containedExecution = true;
    expect(providerCanEnforcePolicy('local-model', contained).ok).toBe(false);
  });

  it('allows local-model for an unrestricted parent', () => {
    const policy = makePolicyLike();
    expect(providerCanEnforcePolicy('local-model', policy).ok).toBe(true);
  });
});

function makePolicyLike(): SideChatAuthorityPolicy {
  return {
    agentToolPermissions: FULL_PERMISSIONS,
    yoloMode: false,
    hardened: false,
    containedExecution: false,
    mandatoryDenyTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
    workspaceNode: 'node-1',
    resolvedAt: Date.now(),
  };
}
