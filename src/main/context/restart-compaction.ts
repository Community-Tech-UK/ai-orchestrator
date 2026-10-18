import type { Instance } from '../../shared/types/instance.types';
import { estimateTokens } from '../../shared/utils/token-estimate';
import { ContextCompactor } from './context-compactor';
import { activeMessagesOf, selectCompactionTail } from './compaction-tail';
import { buildContinuityPackage, latestPriorSummary } from './compaction-continuity';
import { fitCompactionSummary } from './compaction-summary-fit';
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT, extractBranchSummaryBlocks } from './context-compaction-prompt';
import { extractFileOperationsFromTurns } from './file-operation-extractor';

export async function prepareRestartCompaction(
  instance: Instance,
  options: { keepLatestExchanges?: number; maxInputTokens?: number; evidence?: string; decisions?: string } = {},
) {
  const messages = activeMessagesOf(instance);
  const turns = messages.filter(message => message.type === 'user' || message.type === 'assistant');
  const contextWindow = instance.contextUsage?.total || 200000;
  const selected = selectCompactionTail(turns.map(message => ({ role: message.type as 'user' | 'assistant', content: message.content })), contextWindow, options.keepLatestExchanges);
  const recent = selected.keptIndices.map(index => turns[index]!);
  const head = selected.affectedIndices.map(index => turns[index]!);
  const priorSummary = latestPriorSummary(messages);
  const referenceTurns = head.map(message => ({ role: message.type as 'user' | 'assistant', content: message.content }));
  const fileOperations = extractFileOperationsFromTurns(referenceTurns);
  const branches = extractBranchSummaryBlocks(referenceTurns);
  const evidence = [options.evidence, options.decisions].filter((text): text is string => Boolean(text));
  const composeRequest = (sample: readonly { type: string; content: string }[]) => ({
    system: COMPACTION_SYSTEM_PROMPT,
    user: buildCompactionPrompt(sample.map(turn => `[${turn.type}]: ${turn.content}`).join('\n\n'), priorSummary, fileOperations, branches, evidence),
  });
  // A verbatim-only handoff does not need a compression request or its input budget.
  const fitted = head.length ? fitCompactionSummary(head, options.maxInputTokens, composeRequest)
    : { turns: head, sampledCount: 0, skippedRanges: [] };
  let summary = priorSummary ?? '';
  let summaryGenerated = false;
  if (head.length > 0) {
    const compactor = ContextCompactor.createIsolated({ maxContextTokens: contextWindow, autoCompact: false });
    for (const message of [...fitted.turns, ...recent]) compactor.addTurn({
      role: message.type as 'user' | 'assistant', content: message.content, tokenCount: estimateTokens(message.content),
    }, { suppressAutoCompact: true });
    const result = await compactor.compact({ force: true, priorSummary, preserveRecentOverride: recent.length, summaryPrompt: composeRequest(fitted.turns).user });
    summaryGenerated = result.summaryGenerated;
    if (!summaryGenerated) throw new Error('Restart compaction did not generate a summary for the earlier conversation');
    summary = compactor.getState().summaries.at(-1)?.content ?? '';
  }
  return buildContinuityPackage({ summary, recent, messages, contextWindow, evidence: options.evidence, decisions: options.decisions,
    stats: { summaryGenerated, summarySampledMessages: fitted.sampledCount, summaryTotalMessages: head.length, skippedRanges: fitted.skippedRanges },
  });
}
