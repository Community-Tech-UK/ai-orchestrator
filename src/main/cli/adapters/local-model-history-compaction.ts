import type { OutputMessage } from '../../../shared/types/instance.types';
import { estimateTokens } from '../../../shared/utils/token-estimate';
import { selectCompactionTail } from '../../context/compaction-tail';
import { buildContinuityPackage, latestPriorSummary } from '../../context/compaction-continuity';
import { fitCompactionSummary } from '../../context/compaction-summary-fit';
import { ContextCompactor } from '../../context/context-compactor';
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT, extractBranchSummaryBlocks } from '../../context/context-compaction-prompt';
import { extractFileOperationsFromTurns } from '../../context/file-operation-extractor';

export interface LocalModelHistoryTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Local-only provenance; stripped from provider requests. */
  harnessContinuity?: true;
}

export interface CompactLocalHistoryOptions {
  windowTokens: number;
  maxInputTokens?: number;
  summarise?: (turns: LocalModelHistoryTurn[]) => string | Promise<string>;
  /** An explicit user action such as "Compact now": the helper's daily limit does not refuse its summary. */
  userInitiated?: boolean;
}

export interface CompactLocalHistoryResult {
  history: LocalModelHistoryTurn[];
  stats: { keptVerbatim: number; summarised: number; tailChars: number; packageChars: number };
}

function asOutput(turns: readonly LocalModelHistoryTurn[]): OutputMessage[] {
  return turns.map((turn, index) => ({
    id: `local-history-${index}`, timestamp: index, type: turn.role, content: turn.content,
    ...(turn.harnessContinuity
      ? { metadata: { internalInput: { actor: 'harness' as const, source: 'compaction-continuity' as const } } }
      : {}),
  }));
}

/** Uses the shared tail, complete summary-input fit, and continuity package. */
export async function compactLocalHistory(
  history: readonly LocalModelHistoryTurn[],
  options: CompactLocalHistoryOptions,
): Promise<CompactLocalHistoryResult | null> {
  const system = history.filter(turn => turn.role === 'system');
  const conversation = history.filter((turn): turn is LocalModelHistoryTurn & { role: 'user' | 'assistant' } => turn.role !== 'system');
  if (conversation.length < 2) return null;
  const tail = selectCompactionTail(conversation, options.windowTokens);
  if (tail.affectedIndices.length === 0) return null;
  const older = tail.affectedIndices.map(index => conversation[index]!);
  const kept = tail.keptIndices.map(index => conversation[index]!);
  const priorSummary = latestPriorSummary(asOutput(conversation));
  const operations = extractFileOperationsFromTurns(older);
  const branches = extractBranchSummaryBlocks(older);
  const composeRequest = (turns: readonly LocalModelHistoryTurn[]) => ({
    system: COMPACTION_SYSTEM_PROMPT,
    user: buildCompactionPrompt(turns.map(turn => `[${turn.role}]: ${turn.content}`).join('\n\n'),
      priorSummary, operations, branches),
  });
  const fit = fitCompactionSummary(older, options.maxInputTokens ?? 96_000, composeRequest);
  let summary: string;
  if (options.summarise) {
    summary = await options.summarise(fit.turns);
  } else {
    const compactor = ContextCompactor.createIsolated({ maxContextTokens: options.windowTokens, autoCompact: false });
    for (const turn of [...fit.turns, ...kept]) compactor.addTurn({
      role: turn.role, content: turn.content, tokenCount: estimateTokens(turn.content),
    }, { suppressAutoCompact: true });
    const result = await compactor.compact({ force: true, priorSummary,
      preserveRecentOverride: kept.length, summaryPrompt: composeRequest(fit.turns).user,
      ...(options.userInitiated ? { userInitiated: true } : {}) });
    if (!result.summaryGenerated) return null;
    summary = compactor.getState().summaries.at(-1)?.content ?? '';
  }
  const packageResult = buildContinuityPackage({
    summary,
    recent: [],
    messages: asOutput(older),
    contextWindow: options.windowTokens,
    stats: {
      summaryGenerated: true,
      summarySampledMessages: fit.sampledCount,
      summaryTotalMessages: fit.totalCount,
      skippedRanges: fit.skippedRanges,
    },
  });
  const compacted: LocalModelHistoryTurn[] = [
    ...system,
    { role: 'user', content: packageResult.text, harnessContinuity: true },
    { role: 'assistant', content: 'Context restored.' },
    ...kept,
  ];
  const compactedTokens = estimateHistoryTokens(compacted);
  if (compactedTokens >= estimateHistoryTokens(history)
    || (options.windowTokens > 0 && compactedTokens > options.windowTokens)) return null;
  return {
    history: compacted,
    stats: {
      keptVerbatim: kept.length,
      summarised: older.length,
      tailChars: kept.reduce((total, turn) => total + turn.content.length, 0),
      packageChars: packageResult.text.length,
    },
  };
}

export function estimateHistoryTokens(history: readonly LocalModelHistoryTurn[]): number {
  return history.reduce((total, turn) => total + estimateTokens(turn.content), 0);
}
