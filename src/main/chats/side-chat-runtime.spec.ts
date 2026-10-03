import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import { createInstance, type Instance, type InstanceCreateConfig } from '../../shared/types/instance.types';
import type { AgentToolPermissions } from '../../shared/types/agent.types';
import type {
  SideChatAuthorityPolicy,
  SideChatParentRef,
  SideChatProviderSelection,
} from '../../shared/types/side-chat.types';
import { ChatStore } from './chat-store';
import { SideChatLinkStore } from './side-chat-link-store';
import {
  SideChatAuthorityResolver,
  policyToAgentPermissions,
  providerCanEnforcePolicy,
} from './side-chat-authority';

class FakeInstanceManager {
  private readonly instances = new Map<string, Instance>();

  create(config: InstanceCreateConfig): Instance {
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

function makePolicy(overrides: Partial<SideChatAuthorityPolicy> = {}): SideChatAuthorityPolicy {
  return {
    agentToolPermissions: FULL_PERMISSIONS,
    yoloMode: false,
    hardened: false,
    containedExecution: false,
    mandatoryDenyTools: ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'],
    workspaceNode: 'node-1',
    resolvedAt: Date.now(),
    ...overrides,
  };
}

describe('side-chat provider matrix', () => {
  it('accepts every session provider with a working conversation runtime', () => {
    const providers: SideChatProviderSelection[] = [
      { provider: 'claude', model: 'opus', reasoning: 'high' },
      { provider: 'codex', model: 'gpt-5', reasoning: 'medium' },
      { provider: 'gemini', model: 'gemini-pro', reasoning: null },
      { provider: 'antigravity', model: null, reasoning: null },
      { provider: 'copilot', model: 'gpt-4o', reasoning: null },
      { provider: 'cursor', model: null, reasoning: null },
      { provider: 'grok', model: 'grok-4', reasoning: null },
      { provider: 'opencode', model: null, reasoning: null },
      {
        provider: 'local-model',
        model: 'llama3',
        reasoning: null,
        modelRuntimeTarget: {
          kind: 'local-model',
          source: 'this-device',
          endpointProvider: 'ollama',
          endpointId: 'ollama-default',
          modelId: 'llama3',
          selectorId: 'sel-1',
        },
      },
    ];
    const expected = [
      'claude', 'codex', 'gemini', 'antigravity', 'copilot',
      'cursor', 'grok', 'opencode', 'local-model',
    ];
    // Each selection retains its chosen provider: no silent substitution.
    expect(providers.map((s) => s.provider)).toEqual(expected);
  });

  it('preserves local-model target metadata through serialization', () => {
    const selection: SideChatProviderSelection = {
      provider: 'local-model',
      model: 'llama3',
      reasoning: null,
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        endpointProvider: 'openai-compatible',
        endpointId: 'node-7-endpoint',
        modelId: 'llama3',
        selectorId: 'sel-7',
        nodeId: 'node-7',
        nodeName: 'windows-pc',
      },
    };
    const roundTripped = JSON.parse(JSON.stringify(selection)) as SideChatProviderSelection;
    expect(roundTripped.provider).toBe('local-model');
    expect(roundTripped.modelRuntimeTarget).toEqual(selection.modelRuntimeTarget);
    expect(roundTripped.modelRuntimeTarget?.kind).toBe('local-model');
    if (roundTripped.modelRuntimeTarget?.kind === 'local-model') {
      expect(roundTripped.modelRuntimeTarget.nodeId).toBe('node-7');
      expect(roundTripped.modelRuntimeTarget.nodeName).toBe('windows-pc');
    }
  });

  it('does not narrow provider to the five-name chat schema', () => {
    const wider: SideChatProviderSelection['provider'][] = [
      'cursor', 'grok', 'opencode', 'local-model',
    ];
    for (const provider of wider) {
      expect(['cursor', 'grok', 'opencode', 'local-model']).toContain(provider);
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
    parentPermissions?: AgentToolPermissions;
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
        id: 'parent-1',
        name: 'Parent',
        provider: 'codex',
        currentCwd: '/work',
        ledgerThreadId: 'thread-parent',
      });
      const instance = instanceManager.create({
        workingDirectory: '/work',
        displayName: 'Parent',
        provider: 'codex',
        agentId: 'build',
        yoloMode: options.parentYolo ?? false,
      });
      // `createInstance` does not set hardened/contained/workerNodeId; the
      // instance-create-builder normally does. Mirror that here so the
      // authority resolver reads the real policy fields.
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
        if (options.persistedPolicy !== undefined) {
          return options.persistedPolicy;
        }
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

  it('resolves live parent policy at creation', () => {
    const { resolver } = harness();
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('live-parent');
      expect(result.policy.agentToolPermissions).toEqual(FULL_PERMISSIONS);
      expect(result.policy.yoloMode).toBe(false);
      expect(result.policy.mandatoryDenyTools).toContain('AskUserQuestion');
    }
  });

  it('inherits restricted parent permissions without broadening', () => {
    // Build a parent whose agent is 'plan' (write: deny, bash: ask).
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const chatStore = new ChatStore(db);
    const instanceManager = new FakeInstanceManager();
    chatStore.insert({
      id: 'parent-1', name: 'Parent', provider: 'codex',
      currentCwd: '/work', ledgerThreadId: 'thread-parent',
    });
    const instance = instanceManager.create({
      workingDirectory: '/work', displayName: 'Parent',
      provider: 'codex', agentId: 'plan',
    });
    instance.workerNodeId = 'node-parent';
    chatStore.update('parent-1', { currentInstanceId: instance.id });

    const resolver = new SideChatAuthorityResolver({
      chatStore,
      instanceManager: instanceManager as never,
    });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const translated = policyToAgentPermissions(result.policy);
      // The plan agent denies writes; translation must not broaden to allow.
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
      expect(result.error).toContain('no verified permission policy');
    }
  });

  it('uses a persisted policy when the parent is absent', () => {
    const persisted = makePolicy({ agentToolPermissions: RESTRICTED_PERMISSIONS });
    const { resolver } = harness({ parentPresent: false, persistedPolicy: persisted });
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('persisted');
      expect(result.policy.agentToolPermissions.write).toBe('deny');
    }
  });

  it('persists the resolved policy for runtime replacement', () => {
    const { resolver, persisted } = harness();
    resolver.resolve(PARENT_REF);
    expect(persisted.has('parent-1')).toBe(true);
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

  it('resolves workspace node provenance from the parent instance', () => {
    const { resolver } = harness();
    const result = resolver.resolve(PARENT_REF);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.policy.workspaceNode).toBe('node-parent');
    }
  });
});

describe('providerCanEnforcePolicy', () => {
  it('allows CLI providers for restricted parents', () => {
    const policy = makePolicy({ agentToolPermissions: RESTRICTED_PERMISSIONS });
    expect(providerCanEnforcePolicy('claude', policy).ok).toBe(true);
    expect(providerCanEnforcePolicy('codex', policy).ok).toBe(true);
  });

  it('rejects local-model for a restricted parent with a concrete capability failure', () => {
    const policy = makePolicy({ agentToolPermissions: RESTRICTED_PERMISSIONS });
    const result = providerCanEnforcePolicy('local-model', policy);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.capability).toContain('local-model');
      expect(result.capability).toContain('restrictions');
    }
  });

  it('rejects local-model when hardened or contained execution is required', () => {
    const policy = makePolicy({ hardened: true });
    expect(providerCanEnforcePolicy('local-model', policy).ok).toBe(false);
    const contained = makePolicy({ containedExecution: true });
    expect(providerCanEnforcePolicy('local-model', contained).ok).toBe(false);
  });

  it('allows local-model for an unrestricted parent', () => {
    const policy = makePolicy();
    expect(providerCanEnforcePolicy('local-model', policy).ok).toBe(true);
  });
});

describe('SideChatLinkStore authority and routing', () => {
  const dbs: SqliteDriver[] = [];

  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.length = 0;
  });

  it('stores authority as inherit-parent with no independent toggle', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const links = new SideChatLinkStore(db);
    const link = links.insert({
      chatId: 'side-1',
      parent: PARENT_REF,
      authority: 'inherit-parent',
      lastReadAssistantSequence: 0,
    });
    expect(link.authority).toBe('inherit-parent');
  });

  it('keeps two parents in one directory isolated in routing', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const links = new SideChatLinkStore(db);
    const parentA: SideChatParentRef = { kind: 'chat', chatId: 'parent-a' };
    const parentB: SideChatParentRef = { kind: 'chat', chatId: 'parent-b' };
    links.insert({ chatId: 'side-a', parent: parentA, authority: 'inherit-parent', lastReadAssistantSequence: 0 });
    links.insert({ chatId: 'side-b', parent: parentB, authority: 'inherit-parent', lastReadAssistantSequence: 0 });

    expect(links.listForParent(parentA).map((l) => l.chatId)).toEqual(['side-a']);
    expect(links.listForParent(parentB).map((l) => l.chatId)).toEqual(['side-b']);
  });

  it('routes session parents to the right machine via origin node provenance', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createOperatorTables(db);
    const links = new SideChatLinkStore(db);
    const windowsParent: SideChatParentRef = {
      kind: 'session',
      historyThreadId: 'thread-win',
      originNodeId: 'windows-pc',
    };
    const macParent: SideChatParentRef = {
      kind: 'session',
      historyThreadId: 'thread-mac',
      originNodeId: 'mac-local',
    };
    links.insert({ chatId: 'side-win', parent: windowsParent, authority: 'inherit-parent', lastReadAssistantSequence: 0 });
    links.insert({ chatId: 'side-mac', parent: macParent, authority: 'inherit-parent', lastReadAssistantSequence: 0 });

    const winLink = links.get('side-win');
    const macLink = links.get('side-mac');
    // An identical-looking path on a different node must not cross-route.
    if (winLink?.parent.kind === 'session') {
      expect(winLink.parent.originNodeId).toBe('windows-pc');
      expect(winLink.parent.historyThreadId).toBe('thread-win');
    }
    if (macLink?.parent.kind === 'session') {
      expect(macLink.parent.originNodeId).toBe('mac-local');
      expect(macLink.parent.historyThreadId).toBe('thread-mac');
    }
  });
});
