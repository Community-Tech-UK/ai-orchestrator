import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentToolPermissions } from '../../shared/types/agent.types';
import type { ModelRuntimeTarget } from '../../shared/types/local-model-runtime.types';
import type {
  SideChatAuthorityPolicy,
  SideChatParentRef,
  SideChatProviderSelection,
} from '../../shared/types/side-chat.types';
import {
  buildPolicy,
  isVerifiedPolicy,
  policyFingerprint,
  policyToRuntimeConfig,
  providerCanEnforcePolicy,
} from './side-chat-authority';
import { createSideChatHarness, type SideChatHarness } from './side-chat.test-helpers';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

const FULL: AgentToolPermissions = { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' };
const NO_WRITES: AgentToolPermissions = { ...FULL, write: 'deny' };

function policy(overrides: Partial<Omit<SideChatAuthorityPolicy, 'mandatoryDenyTools' | 'resolvedAt'>> = {}) {
  return buildPolicy({
    agentToolPermissions: FULL,
    yoloMode: true,
    hardened: false,
    containedExecution: false,
    browserToolsMode: null,
    computerUseMode: null,
    workspaceNode: null,
    ...overrides,
  });
}

const LOCAL_TARGET: ModelRuntimeTarget = {
  kind: 'local-model',
  source: 'this-device',
  endpointProvider: 'ollama',
  endpointId: 'ollama-default',
  modelId: 'llama3',
  selectorId: 'sel-1',
};

describe('providerCanEnforcePolicy', () => {
  it('lets Claude and toolless local models enforce any policy', () => {
    const restricted = policy({ agentToolPermissions: { ...NO_WRITES, bash: 'deny' }, yoloMode: false, hardened: true });
    expect(providerCanEnforcePolicy('claude', restricted)).toEqual({ ok: true });
    expect(providerCanEnforcePolicy('local-model', restricted)).toEqual({ ok: true });
  });

  it('refuses category denials for providers that cannot block individual tools', () => {
    for (const provider of ['codex', 'gemini', 'antigravity', 'cursor', 'grok', 'opencode', 'copilot']) {
      const result = providerCanEnforcePolicy(provider, policy({ agentToolPermissions: NO_WRITES }));
      expect(result.ok, provider).toBe(false);
    }
  });

  it('allows approval-posture providers for a non-YOLO parent without denials, except Copilot', () => {
    const askFirst = policy({ yoloMode: false });
    for (const provider of ['codex', 'gemini', 'antigravity', 'cursor', 'grok', 'opencode']) {
      expect(providerCanEnforcePolicy(provider, askFirst), provider).toEqual({ ok: true });
    }
    expect(providerCanEnforcePolicy('copilot', askFirst)).toMatchObject({ ok: false });
    expect(providerCanEnforcePolicy('copilot', policy())).toEqual({ ok: true });
  });
});

describe('policy translation', () => {
  it('maps every restriction onto a spawn-time field', () => {
    expect(policyToRuntimeConfig(policy({
      agentToolPermissions: NO_WRITES,
      yoloMode: false,
      hardened: true,
      containedExecution: true,
      browserToolsMode: 'off',
      computerUseMode: 'guarded',
      workspaceNode: 'windows-pc',
    }))).toEqual({
      toolPermissionsOverride: NO_WRITES,
      yoloMode: false,
      hardened: true,
      containedExecution: true,
      browserToolsMode: 'off',
      computerUseMode: 'guarded',
      forceNodeId: 'windows-pc',
    });
  });

  it('changes fingerprint for enforcement changes only', () => {
    const base = policy();
    expect(policyFingerprint({ ...base, resolvedAt: base.resolvedAt + 1000 })).toBe(policyFingerprint(base));
    expect(policyFingerprint(policy({ yoloMode: false }))).not.toBe(policyFingerprint(base));
    expect(policyFingerprint(policy({ browserToolsMode: 'off' }))).not.toBe(policyFingerprint(base));
  });

  it('verifies persisted policies field by field', () => {
    expect(isVerifiedPolicy(policy())).toBe(true);
    expect(isVerifiedPolicy({ ...policy(), agentToolPermissions: { ...FULL, write: 'sometimes' } })).toBe(false);
    expect(isVerifiedPolicy({ ...policy(), yoloMode: 'yes' })).toBe(false);
    expect(isVerifiedPolicy(null)).toBe(false);
  });
});

describe('provider matrix: create → persist → reload → send → switch → rebuild', () => {
  const harnesses: SideChatHarness[] = [];

  afterEach(async () => {
    for (const harness of harnesses.reverse()) await harness.dispose();
    harnesses.length = 0;
  });

  const MATRIX: Array<{ selection: SideChatProviderSelection; instanceProvider: string; model: string | null }> = [
    { selection: { provider: 'claude', model: 'opus', reasoning: 'high' }, instanceProvider: 'claude', model: 'opus' },
    { selection: { provider: 'codex', model: 'gpt-5.5', reasoning: 'medium' }, instanceProvider: 'codex', model: 'gpt-5.5' },
    { selection: { provider: 'gemini', model: 'gemini-pro', reasoning: null }, instanceProvider: 'gemini', model: 'gemini-pro' },
    { selection: { provider: 'antigravity', model: null, reasoning: null }, instanceProvider: 'antigravity', model: null },
    { selection: { provider: 'copilot', model: 'gpt-4o', reasoning: null }, instanceProvider: 'copilot', model: 'gpt-4o' },
    { selection: { provider: 'cursor', model: null, reasoning: null }, instanceProvider: 'cursor', model: null },
    { selection: { provider: 'grok', model: 'grok-4', reasoning: null }, instanceProvider: 'grok', model: 'grok-4' },
    { selection: { provider: 'opencode', model: null, reasoning: null }, instanceProvider: 'opencode', model: null },
    {
      selection: { provider: 'local-model', model: null, reasoning: null, modelRuntimeTarget: LOCAL_TARGET },
      // Local models route through the runtime target, as the new-session composer does.
      instanceProvider: 'auto',
      model: 'llama3',
    },
  ];

  for (const { selection, instanceProvider, model } of MATRIX) {
    it(`keeps ${selection.provider} end to end without falling back to another provider`, async () => {
      const h = createSideChatHarness();
      harnesses.push(h);
      h.runtimes.addSession({
        historyThreadId: 'thread-parent', workingDirectory: '/work', displayName: 'Parent',
        transcript: [{ type: 'user', content: 'Parent task' }],
      });
      const parent: SideChatParentRef = { kind: 'session', historyThreadId: 'thread-parent', originNodeId: null };

      const created = await h.service.sideChats.create({ parent, selection, currentCwd: '/work' });
      const restarted = h.restart();
      harnesses.push(restarted);
      restarted.runtimes.addSession({
        historyThreadId: 'thread-parent', workingDirectory: '/work', displayName: 'Parent',
        transcript: [{ type: 'user', content: 'Parent task' }],
      });
      const reloaded = (await restarted.service.getChat(created.chat.id)).chat;
      expect(reloaded.provider).toBe(selection.provider);
      expect(reloaded.model).toBe(model);
      expect(reloaded.modelRuntimeTarget ?? null).toEqual(selection.modelRuntimeTarget ?? null);

      const sent = await restarted.service.sideChats.send({ chatId: created.chat.id, text: 'Status?' });
      expect(sent.ok).toBe(true);
      const spawn = restarted.runtimes.creates.at(-1)!;
      expect(spawn.provider).toBe(instanceProvider);
      expect(spawn.modelOverride ?? null).toBe(model);
      expect(spawn.modelRuntimeTarget ?? null).toEqual(selection.modelRuntimeTarget ?? null);
      expect(restarted.runtimes.preambles.at(-1)).toContain('Parent task');

      restarted.runtimes.setStatus(reloaded.currentInstanceId ?? (await restarted.service.getChat(created.chat.id)).chat.currentInstanceId!, 'idle');
      const other = selection.provider === 'claude'
        ? { provider: 'codex' as const, model: 'gpt-5.5' }
        : { provider: 'claude' as const, model: 'sonnet' };
      await restarted.service.sideChats.setSelection(created.chat.id, other);
      await restarted.service.sideChats.send({ chatId: created.chat.id, text: 'And after switching?' });
      expect(restarted.runtimes.creates.at(-1)).toMatchObject({ provider: other.provider, modelOverride: other.model });
      const rebuild = restarted.runtimes.preambles.at(-1)!;
      expect(rebuild).toContain('Parent task');
      expect(rebuild).toContain('Status?');
    });
  }

  it('keeps a worker-node local model target, including node metadata, through reload', async () => {
    const h = createSideChatHarness();
    harnesses.push(h);
    h.runtimes.addSession({
      historyThreadId: 'thread-remote', workingDirectory: 'C:\\work', displayName: 'Remote', workerNodeId: 'node-7',
    });
    const target: ModelRuntimeTarget = { ...LOCAL_TARGET, source: 'worker-node', nodeId: 'node-7', nodeName: 'windows-pc' };

    const created = await h.service.sideChats.create({
      parent: { kind: 'session', historyThreadId: 'thread-remote', originNodeId: 'node-7' },
      selection: { provider: 'local-model', model: null, modelRuntimeTarget: target },
      currentCwd: 'C:\\work',
    });
    await h.service.sideChats.send({ chatId: created.chat.id, text: 'Hi' });

    expect((await h.service.getChat(created.chat.id)).chat.modelRuntimeTarget).toEqual(target);
    expect(h.runtimes.creates.at(-1)).toMatchObject({ modelRuntimeTarget: target, forceNodeId: 'node-7' });
  });
});
