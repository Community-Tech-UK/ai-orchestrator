import type { ConversationLedgerConversation } from './conversation-ledger.types';
import type { FileAttachment, Instance } from './instance.types';
import type { SupportedProvider } from './mcp-scopes.types';

export type ChatProvider = SupportedProvider;

export interface ChatRecord {
  id: string;
  name: string;
  provider: ChatProvider | null;
  model: string | null;
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

export interface ChatCreateInput {
  name?: string;
  provider: ChatProvider;
  model?: string | null;
  currentCwd: string;
  yolo?: boolean;
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

export type ChatEvent =
  | { type: 'chat-created'; chatId: string; chat: ChatRecord }
  | { type: 'chat-updated'; chatId: string; chat: ChatRecord }
  | { type: 'chat-archived'; chatId: string }
  | { type: 'transcript-updated'; chatId: string; detail: ChatDetail }
  | { type: 'runtime-linked'; chatId: string; instanceId: string; chat: ChatRecord }
  | { type: 'runtime-cleared'; chatId: string; previousInstanceId: string | null; chat: ChatRecord };
