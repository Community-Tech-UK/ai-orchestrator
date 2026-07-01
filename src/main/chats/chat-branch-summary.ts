import type { ChatRecord } from '../../shared/types/chat.types';
import type {
  ConversationLedgerService,
} from '../conversation-ledger';
import type {
  ConversationMessageRecord,
  ConversationThreadRecord,
} from '../../shared/types/conversation-ledger.types';
import {
  branchSummaryEventId,
  branchSummaryMetadataKey,
  buildBranchSummaryContextBlock,
  createDefaultBranchSummarizer,
  type BranchSummary,
  type BranchSummarizerLike,
} from '../context/branch-summarizer';
import { extractFileOperations, type FileOperation } from '../context/file-operation-extractor';

const BRANCH_SUMMARY_FETCH_LIMIT = 200;
const BRANCH_SUMMARY_TRANSCRIPT_LIMIT = 12_000;

interface BranchSummaryMetadataEntry {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly upToSequence: number;
  readonly eventId: string;
  readonly summary: string;
  readonly fileOperations: readonly FileOperation[];
  readonly createdAt: number;
}

export interface ChatBranchSummaryDeps {
  readonly ledger: ConversationLedgerService;
  readonly fromChat: ChatRecord;
  readonly toChat: ChatRecord;
  readonly appendSummaryEvent: (input: {
    chatId: string;
    nativeMessageId: string;
    nativeTurnId: string;
    content: string;
    metadata: Record<string, unknown>;
  }) => Promise<void>;
  readonly markNeedsRebuild: (chatId: string) => void;
  readonly summarizer?: BranchSummarizerLike;
}

export interface ChatBranchSummarySchedulerDeps {
  readonly ledger: ConversationLedgerService;
  readonly getChat: (chatId: string) => ChatRecord | null;
  readonly appendSummaryEvent: ChatBranchSummaryDeps['appendSummaryEvent'];
  readonly markNeedsRebuild: ChatBranchSummaryDeps['markNeedsRebuild'];
  readonly summarizer?: BranchSummarizerLike;
  readonly onError?: (error: unknown, fromChatId: string, toChatId: string) => void;
}

export class ChatBranchSummaryScheduler {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: ChatBranchSummarySchedulerDeps) {}

  queue(fromChatId: string | null, toChatId: string | null): void {
    if (!fromChatId || !toChatId || fromChatId === toChatId) return;
    const fromChat = this.deps.getChat(fromChatId);
    const toChat = this.deps.getChat(toChatId);
    if (!fromChat || !toChat) return;

    const task = summarizeChatBranchSwitch({
      ledger: this.deps.ledger,
      fromChat,
      toChat,
      appendSummaryEvent: this.deps.appendSummaryEvent,
      markNeedsRebuild: this.deps.markNeedsRebuild,
      summarizer: this.deps.summarizer,
    }).catch((error) => this.deps.onError?.(error, fromChatId, toChatId));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
  }

  async drainForTesting(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}

export async function summarizeChatBranchSwitch(
  deps: ChatBranchSummaryDeps
): Promise<void> {
  if (deps.fromChat.id === deps.toChat.id) return;

  const [fromThread, toThread] = await Promise.all([
    deps.ledger.getThread(deps.fromChat.ledgerThreadId),
    deps.ledger.getThread(deps.toChat.ledgerThreadId),
  ]);
  if (!fromThread || !toThread || !areRelatedBranches(fromThread, toThread)) {
    return;
  }

  const key = branchSummaryMetadataKey(fromThread.id, toThread.id);
  const currentSummaries = readBranchSummaries(toThread.metadata);
  const previous = currentSummaries[key];
  const messages = await deps.ledger.getMessagesAfter(
    fromThread.id,
    previous?.upToSequence ?? 0,
    BRANCH_SUMMARY_FETCH_LIMIT,
  );
  const summarizable = messages.filter(shouldSummarizeMessage);
  if (summarizable.length === 0) {
    return;
  }

  const upToSequence = messages[messages.length - 1]?.sequence ?? previous?.upToSequence ?? 0;
  if (previous && previous.upToSequence >= upToSequence) {
    return;
  }

  const transcriptExcerpt = buildTranscriptExcerpt(summarizable);
  const fileOperations = extractFileOperations(transcriptExcerpt);
  const summarizer = deps.summarizer ?? createDefaultBranchSummarizer();
  const summary = await summarizer.summarize({
    fromNodeId: fromThread.id,
    toNodeId: toThread.id,
    transcriptExcerpt,
    fileOperations,
  });
  const eventId = branchSummaryEventId(fromThread.id, toThread.id, upToSequence);
  await deps.appendSummaryEvent({
    chatId: deps.toChat.id,
    nativeMessageId: eventId,
    nativeTurnId: `branch-summary:${eventId.slice('branch-summary:'.length)}`,
    content: buildBranchSummaryContextBlock(summary),
    metadata: {
      kind: 'branch-summary',
      fromNodeId: fromThread.id,
      toNodeId: toThread.id,
      upToSequence,
      sourceChatId: deps.fromChat.id,
      destinationChatId: deps.toChat.id,
    },
  });

  await deps.ledger.updateThreadMetadata(toThread.id, {
    branchSummaries: {
      ...currentSummaries,
      [key]: metadataEntry(summary, upToSequence, eventId),
    },
  });
  deps.markNeedsRebuild(deps.toChat.id);
}

function areRelatedBranches(
  fromThread: ConversationThreadRecord,
  toThread: ConversationThreadRecord
): boolean {
  if (fromThread.id === toThread.id) return false;
  if (fromThread.parentConversationId === toThread.id) return true;
  if (toThread.parentConversationId === fromThread.id) return true;
  return Boolean(
    fromThread.parentConversationId
    && fromThread.parentConversationId === toThread.parentConversationId
  );
}

function shouldSummarizeMessage(message: ConversationMessageRecord): boolean {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'tool';
}

function buildTranscriptExcerpt(messages: readonly ConversationMessageRecord[]): string {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join('\n\n')
    .trim();
  if (transcript.length <= BRANCH_SUMMARY_TRANSCRIPT_LIMIT) {
    return transcript;
  }
  return transcript.slice(-BRANCH_SUMMARY_TRANSCRIPT_LIMIT);
}

function readBranchSummaries(
  metadata: Record<string, unknown>
): Record<string, BranchSummaryMetadataEntry> {
  const raw = metadata['branchSummaries'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const entries: Record<string, BranchSummaryMetadataEntry> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate['fromNodeId'] === 'string'
      && typeof candidate['toNodeId'] === 'string'
      && typeof candidate['upToSequence'] === 'number'
      && typeof candidate['eventId'] === 'string'
      && typeof candidate['summary'] === 'string'
      && Array.isArray(candidate['fileOperations'])
      && typeof candidate['createdAt'] === 'number'
    ) {
      entries[key] = {
        fromNodeId: candidate['fromNodeId'],
        toNodeId: candidate['toNodeId'],
        upToSequence: candidate['upToSequence'],
        eventId: candidate['eventId'],
        summary: candidate['summary'],
        fileOperations: candidate['fileOperations'].filter(isFileOperation),
        createdAt: candidate['createdAt'],
      };
    }
  }
  return entries;
}

function metadataEntry(
  summary: BranchSummary,
  upToSequence: number,
  eventId: string
): BranchSummaryMetadataEntry {
  return {
    fromNodeId: summary.fromNodeId,
    toNodeId: summary.toNodeId,
    upToSequence,
    eventId,
    summary: summary.summary,
    fileOperations: summary.fileOperations,
    createdAt: summary.createdAt,
  };
}

function isFileOperation(value: unknown): value is FileOperation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['kind'] === 'string'
    && typeof candidate['path'] === 'string'
    && typeof candidate['source'] === 'string'
  );
}
