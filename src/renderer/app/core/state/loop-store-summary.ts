import type { LoopStatePayload } from '@contracts/schemas/loop';
import type { LoopFinalSummaryLastIteration } from './loop-store.types';

/** Truncate the agent's final response so the summary card never blows out. */
const MAX_SUMMARY_OUTPUT_CHARS = 4_000;
/** Truncate verify command output similarly; full logs live in the trace. */
const MAX_SUMMARY_VERIFY_CHARS = 1_500;

export function snapshotLastIteration(
  iteration: LoopStatePayload['lastIteration'],
): LoopFinalSummaryLastIteration | undefined {
  if (!iteration) return undefined;
  return {
    seq: iteration.seq,
    stage: iteration.stage,
    outputExcerpt: truncateForSummary(iteration.outputExcerpt, MAX_SUMMARY_OUTPUT_CHARS),
    outputFull: iteration.outputFull || iteration.outputExcerpt,
    filesChanged: iteration.filesChanged.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    testPassCount: iteration.testPassCount,
    testFailCount: iteration.testFailCount,
    verifyStatus: iteration.verifyStatus,
    verifyOutputExcerpt: truncateForSummary(iteration.verifyOutputExcerpt, MAX_SUMMARY_VERIFY_CHARS),
    progressVerdict: iteration.progressVerdict,
  };
}

function truncateForSummary(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 18).trimEnd()}\n…(truncated)`;
}
