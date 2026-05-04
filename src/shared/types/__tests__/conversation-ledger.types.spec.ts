import { describe, expect, it } from 'vitest';
import type {
  ConversationMessageRecord,
  ConversationThreadRecord,
  NativeConversationCapabilities,
} from '../conversation-ledger.types';

describe('conversation ledger shared types', () => {
  it('constructs serializable thread, message, and capability records', () => {
    const thread: ConversationThreadRecord = {
      id: 'cl_thread_1',
      provider: 'codex',
      nativeThreadId: 'thread_native_1',
      nativeSessionId: null,
      nativeSourceKind: 'appServer',
      sourceKind: 'provider-native',
      sourcePath: null,
      workspacePath: '/tmp/project',
      title: 'Ledger planning',
      createdAt: 1,
      updatedAt: 2,
      lastSyncedAt: null,
      writable: true,
      nativeVisibilityMode: 'app-server-durable',
      syncStatus: 'never-synced',
      conflictStatus: 'none',
      parentConversationId: null,
      metadata: { source: 'test' },
    };

    const message: ConversationMessageRecord = {
      id: 'cl_msg_1',
      threadId: thread.id,
      nativeMessageId: 'msg_1',
      nativeTurnId: 'turn_1',
      role: 'assistant',
      phase: 'final',
      content: 'Use an Orchestrator-owned ledger first.',
      createdAt: 2,
      tokenInput: 12,
      tokenOutput: 8,
      rawRef: 'fixture:1',
      rawJson: { type: 'response_item' },
      sourceChecksum: 'abc123',
      sequence: 1,
    };

    const capabilities: NativeConversationCapabilities = {
      provider: 'codex',
      canDiscover: true,
      canRead: true,
      canCreate: true,
      canResume: true,
      canSendTurns: true,
      canReconcile: true,
      durableByDefault: true,
      nativeVisibilityMode: 'app-server-durable',
    };

    expect(JSON.parse(JSON.stringify({ thread, message, capabilities }))).toMatchObject({
      thread: { provider: 'codex', nativeSourceKind: 'appServer' },
      message: { role: 'assistant', sequence: 1 },
      capabilities: { durableByDefault: true },
    });
  });
});
