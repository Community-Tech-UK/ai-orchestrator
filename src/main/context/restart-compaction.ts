import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CompactionBoundaryOptions } from '../../shared/types/compaction-preview.types';
import { estimateTokens } from '../../shared/utils/token-estimate';
import { ContextCompactor } from './context-compactor';
import { activeMessagesOf, selectCompactionTail } from './compaction-tail';
import { buildContinuityPackage, compactionTurnLabel, latestPriorSummary } from './compaction-continuity';
import { fitCompactionSummary } from './compaction-summary-fit';
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT, extractBranchSummaryBlocks } from './context-compaction-prompt';
import { extractFileOperationsFromTurns } from './file-operation-extractor';
import { resolveCompactionInputLimit } from './compaction-input-limit';
import { getLogger } from '../logging/logger';

export async function prepareRestartCompaction(
  instance: Instance,
  options: Pick<CompactionBoundaryOptions, 'keepLatestExchanges' | 'resumeTurn'> & {
    maxInputTokens?: number;
    evidence?: string;
    decisions?: string;
    recoveryMessageCount?: number;
    /** An explicit user action such as "Compact now": the helper's daily limit does not refuse its summary. */
    userInitiated?: boolean;
  } = {},
) {
  const active = activeMessagesOf(instance);
  let interruptedIndex = -1;
  if (options.resumeTurn && !options.resumeTurn.internalSource) {
    for (let index = active.length - 1; index >= 0; index--) {
      const message = active[index]!;
      if (message.type === 'user' && message.content
        && (options.resumeTurn.text === message.content || options.resumeTurn.text.endsWith(message.content))) {
        interruptedIndex = index;
        break;
      }
    }
  }
  // The interrupted ask is carried by <interrupted_request>; omit its old
  // transcript copy from the summary and recent tail so it appears only once.
  const messages = interruptedIndex < 0 ? active : active.filter((_, index) => index !== interruptedIndex);
  const turns = messages.filter(message => message.type === 'user' || message.type === 'assistant'
    || (message.metadata?.internalInput && message.metadata.internalInput.source !== 'compaction-continuity'));
  getLogger('RestartCompaction').info('Restart summary input provenance', {
    turns: turns.length, harnessTurns: turns.filter(turn => turn.metadata?.internalInput).length,
    harnessTurnsInUserRole: turns.filter(turn => turn.type === 'user' && turn.metadata?.internalInput).length,
  });
  const contextWindow = instance.contextUsage?.total || 200_000;
  const selected = selectCompactionTail(
    turns.map(message => ({ role: message.metadata?.internalInput ? 'assistant' : message.type as 'user' | 'assistant', content: message.content })),
    contextWindow,
    options.keepLatestExchanges,
  );
  const recent = selected.keptIndices.map(index => turns[index]!);
  const head = selected.affectedIndices.map(index => turns[index]!);
  const priorSummary = latestPriorSummary(messages);
  const referenceTurns = head.map(message => ({ role: message.type as 'user' | 'assistant', content: message.content }));
  const fileOperations = extractFileOperationsFromTurns(referenceTurns);
  const branches = extractBranchSummaryBlocks(referenceTurns);
  const carryForward = [options.evidence, options.decisions].filter((text): text is string => Boolean(text));
  const composeRequest = (sample: readonly OutputMessage[]) => ({
    system: COMPACTION_SYSTEM_PROMPT,
    user: buildCompactionPrompt(
      sample.map(turn => `[${compactionTurnLabel(turn)}]: ${turn.content}`).join('\n\n'),
      priorSummary,
      fileOperations,
      branches,
      carryForward,
    ),
  });
  const fitted = head.length
    ? fitCompactionSummary(head, options.maxInputTokens ?? resolveCompactionInputLimit(), composeRequest)
    : { turns: head, sampledCount: 0, skippedRanges: [] as string[] };
  let summary = priorSummary ?? '';
  let summaryGenerated = false;
  if (head.length > 0) {
    const compactor = ContextCompactor.createIsolated({ maxContextTokens: contextWindow, autoCompact: false });
    for (const message of [...fitted.turns, ...recent]) {
      compactor.addTurn({
        role: message.type as 'user' | 'assistant',
        content: message.content,
        tokenCount: estimateTokens(message.content),
      }, { suppressAutoCompact: true });
    }
    const result = await compactor.compact({
      force: true,
      priorSummary,
      preserveRecentOverride: recent.length,
      summaryPrompt: composeRequest(fitted.turns).user,
      ...(options.userInitiated ? { userInitiated: true } : {}),
    });
    summaryGenerated = result.summaryGenerated;
    summary = compactor.getState().summaries.at(-1)?.content ?? '';
    if (!summaryGenerated || !summary.trim()) {
      throw new Error('Restart compaction did not generate a summary for the earlier conversation');
    }
  }
  return buildContinuityPackage({
    summary,
    recent,
    messages,
    contextWindow,
    evidence: options.evidence,
    decisions: options.decisions,
    recoveryMessageCount: options.recoveryMessageCount,
    stats: {
      summaryGenerated,
      summarySampledMessages: fitted.sampledCount,
      summaryTotalMessages: head.length,
      skippedRanges: fitted.skippedRanges,
    },
    ...(options.resumeTurn ? { resumeTurn: {
      text: options.resumeTurn.internalSource
        ? `Original input was sent by Harness (source: ${options.resumeTurn.internalSource}).\n${options.resumeTurn.text}`
        : options.resumeTurn.text,
    } } : {}),
  });
}
