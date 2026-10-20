import { describe, expect, it } from 'vitest';
import type { AgentProfile } from '../../../../shared/types/agent.types';
import type { Instance, InstanceCreateConfig } from '../../../../shared/types/instance.types';
import { buildInstanceRecord } from '../instance-create-builder';

const buildAgent = (overrides: Partial<AgentProfile> = {}): AgentProfile => ({
  id: 'build',
  name: 'Build',
  description: 'Build mode',
  mode: 'build',
  color: '#10b981',
  icon: 'hammer',
  permissions: {
    read: 'allow',
    write: 'allow',
    bash: 'allow',
    web: 'allow',
    task: 'allow',
  },
  builtin: true,
  ...overrides,
});

const buildConfig = (overrides: Partial<InstanceCreateConfig> = {}): InstanceCreateConfig => ({
  workingDirectory: '/repo/project-a',
  ...overrides,
});

describe('buildInstanceRecord', () => {
  it('validates and retains explicit OpenCode folders without sharing caller ownership', () => {
    const additionalDirectories = ['/repo/shared', 'C:\\shared'];
    const deps = { defaultYoloMode: false, getParent: () => undefined };
    const instance = buildInstanceRecord(buildConfig({ provider: 'opencode', additionalDirectories }), buildAgent(), deps);
    expect(instance.additionalDirectories).toEqual(additionalDirectories);
    expect(instance.additionalDirectories).not.toBe(additionalDirectories);
    expect(() => buildInstanceRecord(buildConfig({ provider: 'claude', additionalDirectories }), buildAgent(), deps)).toThrow(/OpenCode/);
  });
  it('builds a new initializing root instance with default lifecycle state', () => {
    const instance = buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), {
      defaultYoloMode: false,
      getParent: () => undefined,
      now: () => 1234,
    });

    expect(instance.id).toMatch(/^c[0-9a-z]{8}$/);
    expect(instance.displayName).toBe('project-a');
    expect(instance.createdAt).toBe(1234);
    expect(instance.status).toBe('initializing');
    expect(instance.contextUsage.used).toBe(0);
    expect(instance.parentId).toBeNull();
    expect(instance.depth).toBe(0);
    expect(instance.agentId).toBe('build');
    expect(instance.launchMode).toBe('orchestrated');
    expect(instance.abortController).toBeInstanceOf(AbortController);
  });

  it('carries the account routing origin and a copy of the account fence onto the instance', () => {
    const fence = ['max-b'];
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', accountRouteOrigin: 'automation', allowedAccountProfileIds: fence }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );
    expect(instance).toMatchObject({ accountRouteOrigin: 'automation', allowedAccountProfileIds: ['max-b'] });
    expect(instance.allowedAccountProfileIds).not.toBe(fence);

    const plain = buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), { defaultYoloMode: false, getParent: () => undefined });
    expect(plain.accountRouteOrigin).toBeUndefined();
    expect(plain.allowedAccountProfileIds).toBeUndefined();
  });

  it('lets an explicit empty failover list (Plan Queue sessions) override the global seed', () => {
    const seeded = { defaultYoloMode: false, getParent: () => undefined, defaultFailoverProviders: ['codex'] };
    expect(buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), seeded).failoverProviders).toEqual(['codex']);
    expect(buildInstanceRecord(buildConfig({ provider: 'claude', failoverProviders: [] }), buildAgent(), seeded).failoverProviders).toBeUndefined();
  });

  it('copies the seeded output buffer so the instance never aliases the caller array', () => {
    const seeded = [
      { id: 'm1', timestamp: 1, type: 'user', content: 'earlier' },
    ] as Instance['outputBuffer'];

    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', initialOutputBuffer: seeded }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );
    instance.outputBuffer.push({ id: 'm2', timestamp: 2, type: 'system', content: 'notice' } as never);

    expect(instance.outputBuffer).toHaveLength(2);
    expect(seeded).toHaveLength(1);
  });

  it('records only an explicit fence-off choice on the instance', () => {
    const deps = { defaultYoloMode: false, getParent: () => undefined };
    expect(buildInstanceRecord(buildConfig({ signalFence: false }), buildAgent(), deps).signalFence).toBe(false);
    expect('signalFence' in buildInstanceRecord(buildConfig({ signalFence: true }), buildAgent(), deps)).toBe(false);
    expect('signalFence' in buildInstanceRecord(buildConfig(), buildAgent(), deps)).toBe(false);
  });

  it('marks a brand-new session as not-yet-persisted to block premature resume', () => {
    const instance = buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), {
      defaultYoloMode: false,
      getParent: () => undefined,
    });

    expect(instance.providerSessionPersisted).toBe(false);
  });

  it('generates app history identity independently from a supplied provider session id', () => {
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', sessionId: 'provider-native-session' }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.sessionId).toBe('provider-native-session');
    expect(instance.providerSessionId).toBe('provider-native-session');
    expect(instance.historyThreadId).not.toBe('provider-native-session');
    expect(instance.historyThreadId).toBeTruthy();
  });

  it('carries an explicit trusted chat conversation owner onto the instance', () => {
    const config = buildConfig({
      provider: 'codex',
      historyThreadId: 'chat-ledger',
      evidenceConversationOwner: {
        kind: 'chat',
        chatId: 'chat-1',
        conversationId: 'chat-ledger',
      },
    });

    const instance = buildInstanceRecord(config, buildAgent(), {
      defaultYoloMode: false,
      getParent: () => undefined,
    });

    expect(instance.evidenceConversationOwner)
      .toEqual({ kind: 'chat', chatId: 'chat-1', conversationId: 'chat-ledger' });
  });

  it('leaves resumed sessions eligible for native resume (persisted flag undefined)', () => {
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', sessionId: 'session-abc', resume: true }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.providerSessionPersisted).toBeUndefined();
  });

  it('leaves restored sessions (with transcript) eligible for native resume', () => {
    const instance = buildInstanceRecord(
      buildConfig({
        provider: 'claude',
        sessionId: 'session-abc',
        initialOutputBuffer: [
          { id: 'm1', type: 'user', content: 'hi', timestamp: 1 },
        ],
      }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.providerSessionPersisted).toBeUndefined();
  });

  it('preserves an explicit interactive launch mode before registration', () => {
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', launchMode: 'interactive' }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.launchMode).toBe('interactive');
  });

  it('seeds currentModel from an explicit modelOverride before async init', () => {
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'cursor', modelOverride: 'composer-2.5' }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.currentModel).toBe('composer-2.5');
  });

  it('seeds an explicit reasoningEffort before async init, leaving defaults to Phase 2', () => {
    const deps = { defaultYoloMode: false, getParent: () => undefined };
    expect(buildInstanceRecord(buildConfig({ provider: 'claude', reasoningEffort: 'max' }), buildAgent(), deps).reasoningEffort)
      .toBe('max');
    expect('reasoningEffort' in buildInstanceRecord(buildConfig({ provider: 'claude', reasoningEffort: null }), buildAgent(), deps))
      .toBe(false);
    expect('reasoningEffort' in buildInstanceRecord(buildConfig({ provider: 'claude' }), buildAgent(), deps)).toBe(false);
    const localModel = buildInstanceRecord(buildConfig({
      provider: 'claude',
      reasoningEffort: 'max',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    }), buildAgent(), deps);
    expect('reasoningEffort' in localModel).toBe(false);
  });

  it('seeds currentModel and runtimeSummary for local-model runtime targets', () => {
    const instance = buildInstanceRecord(
      buildConfig({
        provider: 'claude',
        modelRuntimeTarget: {
          kind: 'local-model',
          source: 'worker-node',
          selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
          nodeId: 'node-win',
          nodeName: 'windows-pc',
          endpointProvider: 'ollama',
          endpointId: 'ollama',
          modelId: 'qwen',
        },
      }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.currentModel).toBe('qwen');
    expect(instance.modelRuntimeTarget).toEqual({
      kind: 'local-model',
      source: 'worker-node',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
    });
    expect(instance.runtimeSummary).toEqual({
      kind: 'local-model',
      label: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
    });
  });

  it('preserves explicit bare mode before async init', () => {
    const instance = buildInstanceRecord(
      buildConfig({ provider: 'claude', bareMode: true }),
      buildAgent(),
      { defaultYoloMode: false, getParent: () => undefined },
    );

    expect(instance.bareMode).toBe(true);
  });

  it('applies configured parent inheritance before registration', () => {
    const parent = {
      agentId: 'parent-agent',
      depth: 2,
      workingDirectory: '/repo/parent',
      yoloMode: true,
    } as Instance;

    const instance = buildInstanceRecord(
      buildConfig({
        contextInheritance: {
          inheritAgentSettings: true,
          inheritYoloMode: true,
        },
        parentId: 'parent-1',
      }),
      buildAgent({ id: 'child-agent' }),
      {
        defaultYoloMode: false,
        getParent: (id) => id === 'parent-1' ? parent : undefined,
        now: () => 5678,
      },
    );

    expect(instance.parentId).toBe('parent-1');
    expect(instance.depth).toBe(3);
    expect(instance.agentId).toBe('parent-agent');
    expect(instance.yoloMode).toBe(true);
  });
});


it.each([
 { isRestoredSession: true }, { sessionId: 'native-existing' }, { historyThreadId: 'prior-history' },
 { metadata: { openCodeForkSessionId: 'native-parent' } }, { initialRetainedPrompts: [{ id: 'old', content: 'older request', timestamp: 1 }] },
])('does not stamp existing-history creation as a fresh provider origin: %j', (overrides) => {
 const instance = buildInstanceRecord(buildConfig({ provider: 'opencode', ...overrides } as InstanceCreateConfig), buildAgent(), { defaultYoloMode: false, getParent: () => undefined });
 expect(instance.providerSessionPersisted).not.toBe(false);
});

it('retains independent immutable placement constraints for actual spawn', () => {
 const nodePlacement = { requiresOpenCodeMajor: 2 as const, preferNodeId: 'worker-placeholder' };
 const instance = buildInstanceRecord(buildConfig({ provider: 'opencode', nodePlacement }), buildAgent(), { defaultYoloMode: false, getParent: () => undefined });
 expect(instance.nodePlacement).toEqual(nodePlacement);
 expect(instance.nodePlacement).not.toBe(nodePlacement);
 nodePlacement.preferNodeId = 'changed-worker';
 expect(instance.nodePlacement?.preferNodeId).toBe('worker-placeholder');
});
