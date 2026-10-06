import { describe, expect, it } from 'vitest';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import { sideChatParentFor, sideChatParentSelectionFor } from './side-chat-parent';
import { describePermissionPolicy } from './side-chat-permissions';
import type { SideChatAuthorityPolicy } from '../../../../shared/types/side-chat.types';

const CHAT: ChatRecord = {
  id: 'chat-1', name: 'Chat', provider: 'codex', model: 'gpt-5.5', reasoningEffort: 'medium', currentCwd: '/w',
  projectId: null, yolo: false, ledgerThreadId: 't', currentInstanceId: 'runtime-1', createdAt: 1, lastActiveAt: 1, archivedAt: null,
};

describe('sideChatParentFor', () => {
  it('keys a chat by id and a session by its stable history thread, never by runtime', () => {
    expect(sideChatParentFor(CHAT, null)).toEqual({ kind: 'chat', chatId: 'chat-1' });
    expect(sideChatParentFor(null, { historyThreadId: 'thread-9', workerNodeId: 'windows-pc' }))
      .toEqual({ kind: 'session', historyThreadId: 'thread-9', originNodeId: 'windows-pc' });
    expect(sideChatParentFor(null, null)).toBeNull();
  });
});

describe('sideChatParentSelectionFor', () => {
  it('offers the parent\'s own provider and model', () => {
    expect(sideChatParentSelectionFor(CHAT, null)).toMatchObject({ provider: 'codex', model: 'gpt-5.5', reasoning: 'medium' });
    expect(sideChatParentSelectionFor(null, { provider: 'grok', currentModel: 'grok-4' })).toEqual({ provider: 'grok', model: 'grok-4' });
  });

  it('keeps a local model target and ignores providers sidechats cannot run', () => {
    const target = {
      kind: 'local-model' as const, source: 'this-device' as const, endpointProvider: 'ollama' as const,
      endpointId: 'e', modelId: 'llama3', selectorId: 's',
    };
    expect(sideChatParentSelectionFor(null, { provider: 'auto', modelRuntimeTarget: target }))
      .toEqual({ provider: 'local-model', model: null, modelRuntimeTarget: target });
    expect(sideChatParentSelectionFor(null, { provider: 'auto' })).toBeNull();
  });
});

describe('describePermissionPolicy', () => {
  it('spells out inherited restrictions in plain words', () => {
    const policy: SideChatAuthorityPolicy = {
      agentToolPermissions: { read: 'allow', write: 'deny', bash: 'ask', web: 'allow', task: 'allow' },
      yoloMode: false, hardened: true, containedExecution: false, browserToolsMode: 'off', computerUseMode: null,
      mandatoryDenyTools: [], workspaceNode: 'windows-pc', resolvedAt: 1,
    };

    expect(describePermissionPolicy(policy)).toEqual([
      'Reading files: allowed',
      'Editing files: blocked',
      'Shell commands: asks first',
      'Web access: allowed',
      'Subagents: allowed',
      'Approvals: asks before acting',
      'Sandbox: runs inside the macOS sandbox',
      'Browser tools: off',
      'Runs on worker: windows-pc',
    ]);
  });
});
