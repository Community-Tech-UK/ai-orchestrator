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
} from '../../../shared/types/conversation-ledger.types';
import { NativeConversationError, type NativeConversationAdapter } from '../native-conversation-adapter';

export const GLOBAL_ORCHESTRATOR_NATIVE_THREAD_ID = 'orchestrator:global';
const GLOBAL_ORCHESTRATOR_TITLE = 'Orchestrator';

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
      thread: {
        provider: this.provider,
        nativeThreadId: ref.nativeThreadId,
        nativeSourceKind: 'internal',
        workspacePath: null,
        title: GLOBAL_ORCHESTRATOR_TITLE,
        writable: true,
        nativeVisibilityMode: 'none',
      },
      messages: [],
      warnings: [],
      rawRefs: [],
    };
  }

  async startThread(request: NativeThreadStartRequest): Promise<NativeConversationHandle> {
    return {
      provider: this.provider,
      nativeThreadId: GLOBAL_ORCHESTRATOR_NATIVE_THREAD_ID,
      nativeSessionId: null,
      workspacePath: null,
      title: request.title ?? GLOBAL_ORCHESTRATOR_TITLE,
      metadata: {
        operatorThreadKind: 'global',
        ...(request.metadata ?? {}),
      },
    };
  }

  async resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle> {
    return {
      provider: this.provider,
      nativeThreadId: ref.nativeThreadId,
      nativeSessionId: null,
      workspacePath: null,
      title: GLOBAL_ORCHESTRATOR_TITLE,
      metadata: { operatorThreadKind: 'global' },
    };
  }

  async sendTurn(ref: NativeConversationRef, request: NativeTurnRequest): Promise<NativeTurnResult> {
    if (ref.nativeThreadId !== GLOBAL_ORCHESTRATOR_NATIVE_THREAD_ID) {
      throw new NativeConversationError(
        `Unknown internal orchestrator thread ${ref.nativeThreadId}`,
        'THREAD_NOT_FOUND',
        this.provider
      );
    }

    const nativeTurnId = `operator-turn:${randomUUID()}`;
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
          phase: 'input',
          content: request.text,
          createdAt,
          sequence: 1,
          rawJson: {
            inputItems: request.inputItems ?? [],
            metadata: request.metadata ?? {},
          },
        },
        {
          nativeMessageId: `${nativeTurnId}:assistant`,
          nativeTurnId,
          role: 'assistant',
          phase: 'recorded',
          content: 'Request recorded. Operator execution is not enabled in this foundation build.',
          createdAt: createdAt + 1,
          sequence: 2,
          rawJson: {
            executionEnabled: false,
            runId: null,
          },
        },
      ],
      metadata: {
        executionEnabled: false,
        runId: null,
      },
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
}
