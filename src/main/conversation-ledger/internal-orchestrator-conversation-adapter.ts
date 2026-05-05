import { randomUUID } from 'crypto';
import type {
  ConversationDiscoveryScope,
  NativeConversationCapabilities,
  NativeConversationHandle,
  NativeConversationRef,
  NativeConversationSnapshot,
  NativeConversationThread,
  NativeThreadStartRequest,
  NativeTurnRequest,
  NativeTurnResult,
  ReconciliationResult,
} from '../../shared/types/conversation-ledger.types';
import type { NativeConversationAdapter } from './native-conversation-adapter';

export const INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID = 'orchestrator-global';

export class InternalOrchestratorConversationAdapter implements NativeConversationAdapter {
  readonly provider = 'orchestrator' as const;

  getCapabilities(): NativeConversationCapabilities {
    return {
      provider: this.provider,
      canDiscover: false,
      canRead: false,
      canCreate: true,
      canResume: true,
      canSendTurns: true,
      canReconcile: false,
      durableByDefault: true,
      nativeVisibilityMode: 'none',
    };
  }

  async discover(_scope: ConversationDiscoveryScope): Promise<NativeConversationThread[]> {
    return [];
  }

  async readThread(ref: NativeConversationRef): Promise<NativeConversationSnapshot> {
    return {
      thread: this.threadFromRef(ref),
      messages: [],
      warnings: ['Internal orchestrator conversations are stored directly in the conversation ledger.'],
      rawRefs: [],
    };
  }

  async startThread(request: NativeThreadStartRequest): Promise<NativeConversationHandle> {
    return {
      provider: this.provider,
      nativeThreadId: INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
      nativeSessionId: INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
      workspacePath: request.workspacePath ?? null,
      title: request.title ?? 'Orchestrator',
      metadata: {
        scope: 'global',
        operatorThreadKind: 'root',
        ...(request.metadata ?? {}),
      },
    };
  }

  async resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle> {
    return {
      provider: this.provider,
      nativeThreadId: ref.nativeThreadId,
      nativeSessionId: ref.nativeThreadId,
      workspacePath: ref.workspacePath ?? null,
      title: 'Orchestrator',
    };
  }

  async sendTurn(ref: NativeConversationRef, request: NativeTurnRequest): Promise<NativeTurnResult> {
    const nativeTurnId = `operator-turn-${randomUUID()}`;
    const createdAt = Date.now();
    return {
      provider: this.provider,
      nativeThreadId: ref.nativeThreadId,
      nativeTurnId,
      messages: [
        {
          nativeMessageId: `${nativeTurnId}:user`,
          nativeTurnId,
          role: 'user',
          content: request.text,
          createdAt,
          sequence: 1,
          rawJson: {
            metadata: request.metadata ?? {},
          },
        },
      ],
      metadata: request.metadata,
    };
  }

  async reconcile(ref: NativeConversationRef): Promise<ReconciliationResult> {
    return {
      threadId: ref.threadId,
      provider: this.provider,
      nativeThreadId: ref.nativeThreadId,
      addedMessages: 0,
      updatedMessages: 0,
      deletedMessages: 0,
      syncStatus: 'synced',
      conflictStatus: 'none',
      warnings: [],
    };
  }

  private threadFromRef(ref: NativeConversationRef): NativeConversationThread {
    return {
      provider: this.provider,
      nativeThreadId: ref.nativeThreadId,
      nativeSessionId: ref.nativeThreadId,
      sourcePath: ref.sourcePath ?? null,
      workspacePath: ref.workspacePath ?? null,
      title: 'Orchestrator',
      writable: true,
      nativeVisibilityMode: 'none',
      metadata: {
        scope: 'global',
        operatorThreadKind: 'root',
      },
    };
  }
}
