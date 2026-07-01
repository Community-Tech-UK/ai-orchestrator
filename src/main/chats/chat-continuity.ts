import type { ConversationLedgerService } from '../conversation-ledger';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import { getLogger } from '../logging/logger';
import { ledgerRecordsToOutputMessages } from './ledger-record-to-output';
import { buildReplayContinuityMessage } from '../session/replay-continuity';

const logger = getLogger('ChatContinuity');

/** Verbatim conversational turns replayed after the latest checkpoint on rebuild. */
const CHAT_REBUILD_MAX_TURNS = 30;
/** Upper bound on messages fetched after a checkpoint when rebuilding. */
const CHAT_REBUILD_VERBATIM_FETCH_LIMIT = 200;
/** Minimum new conversational turns past the last checkpoint before producing a
 *  new one — keeps the uncheckpointed tail bounded without churning the LLM. */
const CHAT_CHECKPOINT_MIN_UNCHECKPOINTED = 60;
/** Verbatim messages kept un-summarized at the tail when producing a checkpoint. */
const CHAT_CHECKPOINT_VERBATIM_TAIL = 20;
/** Approximate token budget for a checkpoint summary. */
const CHAT_CHECKPOINT_TARGET_TOKENS = 1500;
/**
 * Hard cap on uncheckpointed messages folded in a single producer pass. Bounds
 * the summarization prompt size: a huge legacy thread is compacted incrementally
 * over several sends (each pass folds the prior summary + this batch) rather than
 * in one enormous prompt.
 */
const CHAT_CHECKPOINT_FETCH_LIMIT = 200;

/**
 * Build the continuity preamble from the ledger (§4.3), checkpoint-aware (§4.4):
 * walk `[durable summary checkpoint] + [verbatim turns after it]` so the rebuild
 * stays bounded under huge loop histories instead of silently dropping older
 * turns.
 *
 * `recentPriorTurns` is the recent ledger tail (excluding the current turn),
 * used as the verbatim source when no checkpoint exists. When a checkpoint is
 * present, the verbatim turns after it are fetched explicitly so no messages
 * between the checkpoint and the recent window are lost.
 */
export async function buildLedgerRebuildPreamble(
  ledger: ConversationLedgerService,
  threadId: string,
  recentPriorTurns: ConversationMessageRecord[],
  currentSequence: number,
  reason: string,
): Promise<string | null> {
  const checkpoint = await ledger.getLatestCheckpoint(threadId);
  let verbatim = recentPriorTurns;
  if (checkpoint) {
    const after = await ledger.getMessagesAfter(
      threadId,
      checkpoint.upToSequence,
      CHAT_REBUILD_VERBATIM_FETCH_LIMIT,
    );
    verbatim = after.filter((m) => m.sequence < currentSequence);
  }
  const replay = buildReplayContinuityMessage(ledgerRecordsToOutputMessages(verbatim), {
    reason: reason === 'loop-divergence' ? 'loop-context-restore' : 'session-rebuild',
    maxTurns: CHAT_REBUILD_MAX_TURNS,
  });
  const branchSummaryContext = verbatim
    .filter(isBranchSummaryRecord)
    .map((message) => message.content)
    .join('\n\n');
  if (!checkpoint) {
    return joinContextBlocks(branchSummaryContext, replay);
  }
  const summaryBlock = [
    '<conversation_summary>',
    `Earlier conversation (the first ${checkpoint.summarizedMessageCount} messages) was compacted into this durable summary. Treat it as already-established context:`,
    checkpoint.summary,
    '</conversation_summary>',
  ].join('\n');
  return joinContextBlocks(summaryBlock, branchSummaryContext, replay);
}

export function isRebuildContextTurn(message: ConversationMessageRecord): boolean {
  if (message.role === 'user' || message.role === 'assistant') {
    return true;
  }
  return isBranchSummaryRecord(message);
}

function isBranchSummaryRecord(message: ConversationMessageRecord): boolean {
  const metadata = message.rawJson?.['metadata'];
  return (
    message.phase === 'branch_summary'
    || (
      metadata !== null
      && typeof metadata === 'object'
      && !Array.isArray(metadata)
      && (metadata as Record<string, unknown>)['kind'] === 'branch-summary'
    )
  );
}

function joinContextBlocks(
  ...blocks: readonly (string | null | undefined)[]
): string | null {
  const joined = blocks
    .map((block) => block?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n');
  return joined || null;
}

/**
 * Durable compaction checkpoint producer (§4.4). Folds the older portion of the
 * uncheckpointed tail into an LLM summary so future rebuilds stay bounded.
 * Best-effort and intended to run off the send hot path:
 *
 * - Only runs once enough new conversational turns have accrued past the last
 *   checkpoint ({@link CHAT_CHECKPOINT_MIN_UNCHECKPOINTED}).
 * - Keeps a verbatim tail un-summarized ({@link CHAT_CHECKPOINT_VERBATIM_TAIL}).
 * - Skips entirely when no real summarizer is available, so we never persist a
 *   lossy truncation as a checkpoint (plan §10). Verbatim is never deleted, so a
 *   checkpoint is always regenerable.
 */
export async function maybeProduceCheckpoint(
  ledger: ConversationLedgerService,
  chatId: string,
  threadId: string,
): Promise<void> {
  const latest = await ledger.getLatestCheckpoint(threadId);
  const fromSequence = latest?.upToSequence ?? 0;
  const uncheckpointed = await ledger.getMessagesAfter(
    threadId,
    fromSequence,
    CHAT_CHECKPOINT_FETCH_LIMIT,
  );
  const conversational = uncheckpointed.filter(
    (m) => m.role === 'user' || m.role === 'assistant',
  );
  if (conversational.length < CHAT_CHECKPOINT_MIN_UNCHECKPOINTED) {
    return;
  }
  const toSummarize = uncheckpointed.slice(
    0,
    Math.max(0, uncheckpointed.length - CHAT_CHECKPOINT_VERBATIM_TAIL),
  );
  if (toSummarize.length === 0) {
    return;
  }
  const upTo = toSummarize[toSummarize.length - 1]!;
  const { getLLMService } = await import('../rlm/llm-service');
  const llm = getLLMService();
  if (!(await llm.isAvailable())) {
    return; // no real summarizer — leave the bounded verbatim tail in charge.
  }
  const priorSummary = latest?.summary
    ? `Summary of the conversation so far:\n${latest.summary}\n\n---\nNewer messages to fold in:\n`
    : '';
  const transcript = toSummarize
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'Human' : 'Assistant'}: ${m.content}`)
    .join('\n');
  if (!transcript.trim()) {
    return;
  }
  const summary = await llm.summarize({
    requestId: `chat-checkpoint:${chatId}:${upTo.sequence}`,
    content: priorSummary + transcript,
    targetTokens: CHAT_CHECKPOINT_TARGET_TOKENS,
    preserveKeyPoints: true,
  });
  if (!summary.trim()) {
    return;
  }
  const summarizedMessageCount = (latest?.summarizedMessageCount ?? 0) + toSummarize.length;
  await ledger.writeCheckpoint(threadId, {
    upToSequence: upTo.sequence,
    upToNativeId: upTo.nativeMessageId,
    summary,
    summarizedMessageCount,
    summaryTokens: llm.countTokens(summary),
  });
  logger.info('Wrote conversation checkpoint', {
    chatId,
    upToSequence: upTo.sequence,
    summarizedMessageCount,
  });
}
