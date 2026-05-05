import type {
  ConversationLedgerConversation,
  ConversationMessageRecord,
  ConversationThreadRecord,
} from './conversation-ledger.types';

export type OperatorRunStatus =
  | 'queued'
  | 'planning'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface OperatorRunSummary {
  id: string;
  conversationThreadId: string;
  prompt: string;
  status: OperatorRunStatus;
  createdAt: number;
  updatedAt: number;
  currentStep: string | null;
  error: string | null;
}

export interface OperatorProjectSummary {
  key: string;
  path: string | null;
  title: string;
  sessionCount: number;
  activeRunCount: number;
  updatedAt: number;
}

export interface OperatorThreadResult {
  conversation: ConversationLedgerConversation;
  runs: OperatorRunSummary[];
  projects: OperatorProjectSummary[];
}

export interface OperatorSendMessageRequest {
  text: string;
  metadata?: Record<string, unknown>;
}

export interface OperatorSendMessageResult extends OperatorThreadResult {
  run: OperatorRunSummary | null;
}

export type OperatorEventKind =
  | 'state-change'
  | 'progress'
  | 'recovery';

export interface OperatorEvent {
  kind: OperatorEventKind;
  runId: string | null;
  nodeId: string | null;
  message: string;
  createdAt: number;
  payload: Record<string, unknown>;
}

export type OperatorConversationThread = ConversationThreadRecord;
export type OperatorConversationMessage = ConversationMessageRecord;
