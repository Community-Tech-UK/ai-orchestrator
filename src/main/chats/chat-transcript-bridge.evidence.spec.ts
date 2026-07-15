import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { ChatRecord } from '../../shared/types/chat.types';
import type { ConversationThreadRecord } from '../../shared/types/conversation-ledger.types';

vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: vi.fn() }));
vi.mock('../providers/provider-output-event', () => ({
  toOutputMessageFromProviderEnvelope: vi.fn(() => null),
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { ChatTranscriptBridge } from './chat-transcript-bridge';

function canonicalThread(id: string): ConversationThreadRecord {
  return {
    id,
    provider: 'orchestrator',
    nativeThreadId: `native-${id}`,
    nativeSessionId: null,
    nativeSourceKind: 'internal',
    sourceKind: 'orchestrator',
    sourcePath: null,
    workspacePath: '/work',
    title: null,
    createdAt: 1,
    updatedAt: 1,
    lastSyncedAt: 1,
    writable: true,
    nativeVisibilityMode: 'none',
    syncStatus: 'synced',
    conflictStatus: 'none',
    parentConversationId: null,
    metadata: { scope: 'chat' },
  };
}

function chat(ledgerThreadId: string): ChatRecord {
  return {
    id: 'chat-1',
    name: 'Chat',
    provider: 'codex',
    model: null,
    reasoningEffort: null,
    currentCwd: '/work',
    projectId: null,
    yolo: false,
    ledgerThreadId,
    currentInstanceId: 'instance-1',
    createdAt: 1,
    lastActiveAt: 1,
    archivedAt: null,
  };
}

function envelope(sessionId: string): ProviderRuntimeEventEnvelope {
  return {
    instanceId: 'instance-1',
    provider: 'codex',
    sessionId,
    eventId: 'event-1',
    seq: 1,
    timestamp: 1,
    turnId: 'turn-1',
    event: {
      kind: 'tool_result',
      toolName: 'Read',
      toolUseId: 'tool-1',
      success: true,
      output: 'result',
    },
  };
}

describe('ChatTranscriptBridge canonical evidence ownership', () => {
  it('writes to the chat ledger even when a provider session id collides with another conversation', async () => {
    const canonical = canonicalThread('chat-ledger');
    const other = canonicalThread('other-conversation');
    const record = chat(canonical.id);
    const instanceManager = Object.assign(new EventEmitter(), {
      getInstance: vi.fn(() => ({
        id: 'instance-1',
        historyThreadId: 'untrusted-history-value',
        provider: 'codex',
        providerSessionId: other.id,
        sessionId: other.id,
        workingDirectory: '/work',
        contextEvidence: { mode: 'shadow', captureFailureCount: 0 },
      })),
    });
    const ledger = {
      getThread: vi.fn(async (id: string) => id === canonical.id ? canonical : other),
      listConversations: vi.fn(async () => [canonical, other]),
      startConversation: vi.fn(),
      appendMessagesReturningRecords: vi.fn(async (threadId: string) => [{
        id: 'message-1',
        threadId,
        nativeMessageId: null,
        nativeTurnId: 'turn-1',
        role: 'tool',
        phase: 'tool_result',
        content: 'result',
        createdAt: 1,
        tokenInput: null,
        tokenOutput: null,
        rawRef: null,
        rawJson: null,
        sourceChecksum: null,
        sequence: 1,
      }]),
    };
    const chatStore = {
      get: vi.fn(() => record),
      getByInstanceId: vi.fn(() => record),
      update: vi.fn(() => record),
    };
    const bridge = new ChatTranscriptBridge({
      ledger: ledger as never,
      chatStore: chatStore as never,
      instanceManager: instanceManager as never,
      eventBus: new EventEmitter(),
      flushIntervalMs: 10_000,
    });
    bridge.start();

    instanceManager.emit('provider:normalized-event', envelope(other.id));
    await bridge.flush();

    expect(ledger.appendMessagesReturningRecords).toHaveBeenCalledWith(
      canonical.id,
      expect.any(Array),
    );
    expect(ledger.appendMessagesReturningRecords).not.toHaveBeenCalledWith(
      other.id,
      expect.any(Array),
    );
    bridge.stop();
  });

  it('does not fall back to provider identity when the chat ledger row is missing', async () => {
    const record = chat('missing-ledger');
    const runtimeInstance = {
      id: 'instance-1',
      historyThreadId: 'history-1',
      provider: 'codex',
      providerSessionId: 'provider-native-collision',
      sessionId: 'provider-native-collision',
      workingDirectory: '/work',
      contextEvidence: { mode: 'enforce' as const, captureFailureCount: 0 },
    };
    const instanceManager = Object.assign(new EventEmitter(), {
      getInstance: vi.fn(() => runtimeInstance),
    });
    const ledger = {
      getThread: vi.fn(async () => null),
      listConversations: vi.fn(async () => [canonicalThread('provider-native-collision')]),
      startConversation: vi.fn(),
      appendMessagesReturningRecords: vi.fn(),
    };
    const bridge = new ChatTranscriptBridge({
      ledger: ledger as never,
      chatStore: {
        get: vi.fn(() => record),
        getByInstanceId: vi.fn(() => record),
        update: vi.fn(() => record),
      } as never,
      instanceManager: instanceManager as never,
      eventBus: new EventEmitter(),
      flushIntervalMs: 10_000,
    });
    bridge.start();

    instanceManager.emit('provider:normalized-event', envelope('provider-native-collision'));
    await bridge.flush();

    expect(ledger.appendMessagesReturningRecords).not.toHaveBeenCalled();
    expect(ledger.listConversations).not.toHaveBeenCalled();
    expect(ledger.startConversation).not.toHaveBeenCalled();
    expect(runtimeInstance.contextEvidence).toMatchObject({
      mode: 'enforce',
      captureFailureCount: 1,
      lastCaptureFailure: {
        code: 'unresolved-conversation-ownership',
        disposition: 'pause-before-destructive-action',
      },
    });
    bridge.stop();
  });
});
