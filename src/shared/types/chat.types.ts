import type { ConversationLedgerConversation, ConversationMessageRecord } from './conversation-ledger.types';
import type { FileAttachment, Instance } from './instance.types';
import type { SupportedProvider } from './mcp-scopes.types';
import type { ReasoningEffort } from './provider.types';
import type { SideChatParentRef, SideChatProviderSelection } from './side-chat.types';
import type { ModelRuntimeTarget } from './local-model-runtime.types';

export type ChatProvider = SupportedProvider | 'cursor' | 'local-model';

/** Provider types accepted by the runtime builder (excludes `local-model`). */
export type ChatRuntimeProvider = SupportedProvider | 'cursor';

export interface ChatRecord {
  id: string;
  name: string;
  provider: ChatProvider | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  modelRuntimeTarget?: ModelRuntimeTarget | null;
  currentCwd: string | null;
  projectId: string | null;
  yolo: boolean;
  ledgerThreadId: string;
  currentInstanceId: string | null;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
}

export interface ChatDetail {
  chat: ChatRecord;
  conversation: ConversationLedgerConversation;
  currentInstance: Instance | null;
}

export interface ChatUiState {
  selectedChatId: string | null;
  openChatIds: string[];
  updatedAt: number;
}

export interface ChatCreateInput {
  name?: string;
  provider: ChatProvider;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  currentCwd: string;
  parentChatId?: string;
  yolo?: boolean;
}

/**
 * Creation input for a session-linked sidechat. `parent` is mandatory: a
 * sidechat is never an unlinked chat dressed up as one. `selection` carries the
 * unified picker's provider, model, reasoning and local runtime target.
 */
export interface ChatSideChatCreateInput {
  parent: SideChatParentRef;
  name?: string;
  selection: SideChatProviderSelection;
  currentCwd: string;
}

export interface ChatSendMessageInput {
  chatId: string;
  text: string;
  attachments?: FileAttachment[];
}

export interface ChatSetCwdInput {
  chatId: string;
  cwd: string;
}

export interface ChatSetProviderInput {
  chatId: string;
  provider: ChatProvider;
}

export interface ChatSetModelInput {
  chatId: string;
  model: string | null;
}

export interface ChatSetReasoningInput {
  chatId: string;
  reasoningEffort: ReasoningEffort | null;
}

export interface ChatSetYoloInput {
  chatId: string;
  yolo: boolean;
}

export interface ChatRenameInput {
  chatId: string;
  name: string;
}

export interface ChatArchiveInput {
  chatId: string;
}

export interface ChatDeleteInput {
  chatId: string;
  confirmation: 'delete';
}

export type ChatEvent =
  | { type: 'chat-created'; chatId: string; chat: ChatRecord }
  | { type: 'chat-updated'; chatId: string; chat: ChatRecord }
  | { type: 'chat-archived'; chatId: string }
  | { type: 'chat-deleted'; chatId: string }
  | {
      /**
       * Incremental transcript update. Carries only the message(s) appended by
       * this event — never the full conversation — so a long-running chat does
       * not re-serialize its entire (potentially multi-MB, attachment-laden)
       * transcript over IPC on every provider event. The renderer merges the
       * delta into its existing detail, preserving prior message identities.
       */
      type: 'transcript-appended';
      chatId: string;
      chat: ChatRecord;
      messages: ConversationMessageRecord[];
      currentInstance: Instance | null;
    }
  | { type: 'runtime-linked'; chatId: string; instanceId: string; chat: ChatRecord }
  | { type: 'runtime-cleared'; chatId: string; previousInstanceId: string | null; chat: ChatRecord };
