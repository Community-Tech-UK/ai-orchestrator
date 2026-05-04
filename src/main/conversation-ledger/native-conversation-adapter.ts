import type {
  ConversationDiscoveryScope,
  ConversationProvider,
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

export interface NativeConversationAdapter {
  readonly provider: ConversationProvider;
  getCapabilities(): NativeConversationCapabilities;
  discover(scope: ConversationDiscoveryScope): Promise<NativeConversationThread[]>;
  readThread(ref: NativeConversationRef): Promise<NativeConversationSnapshot>;
  startThread(request: NativeThreadStartRequest): Promise<NativeConversationHandle>;
  resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle>;
  sendTurn(ref: NativeConversationRef, request: NativeTurnRequest): Promise<NativeTurnResult>;
  reconcile(ref: NativeConversationRef): Promise<ReconciliationResult>;
}

export class NativeConversationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly provider: ConversationProvider,
    override readonly cause?: unknown
  ) {
    super(message);
    this.name = 'NativeConversationError';
  }
}
