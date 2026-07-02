/**
 * Structured compaction prompt helpers.
 */

import { summarizeFileOperations, type FileOperation } from './file-operation-extractor';

/**
 * Structured compaction prompt sections. The prior summary (if any) is injected
 * as an anchor so decisions/state from earlier compaction rounds are preserved.
 */
const COMPACTION_TEMPLATE_SECTIONS = [
  '## Active Task',
  '## User Goal',
  '## Constraints',
  '## Completed Actions',
  '## Active State',
  '## In Progress',
  '## Blocked',
  '## Key Decisions',
  '## Pending User Asks',
  '## Relevant Files',
  '## File Operations Observed',
  '## Remaining Work',
  '## Critical Context',
] as const;

/**
 * Redact common secret patterns from generated summary text before storage.
 * This prevents API keys, tokens, and credentials from leaking into persisted summaries.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED_SK]')
    .replace(/ghp_[A-Za-z0-9]{10,}/g, '[REDACTED_GHP]')
    .replace(/xoxb-[A-Za-z0-9-]{10,}/g, '[REDACTED_SLACK]')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/password\s*=\s*\S+/gi, 'password=[REDACTED]')
    .replace(/token\s*=\s*\S+/gi, 'token=[REDACTED]')
    .replace(/api_key\s*=\s*\S+/gi, 'api_key=[REDACTED]');
}

/** Maximum branch-switch summary blocks injected into one compaction prompt. */
const MAX_BRANCH_SUMMARIES_IN_PROMPT = 3;

/** Minimal structural view of a turn for branch-summary extraction. */
export interface BranchSummarySourceTurn {
  readonly content: string;
  readonly metadata?: Record<string, unknown>;
}

const BRANCH_SUMMARY_BLOCK_PATTERN = /<branch_switch_summary>[\s\S]*?<\/branch_switch_summary>/g;

/**
 * Collect branch-switch summary blocks from the turns about to be compacted so
 * the summarizer can preserve cross-branch context. Blocks arrive either as
 * whole turns flagged `kind: 'branch-summary'` (ledger branch-summary events)
 * or embedded inside a turn's content (continuity/rebuild preambles). Returns
 * the most recent blocks, oldest first, bounded to keep the prompt small.
 */
export function extractBranchSummaryBlocks(
  turns: readonly BranchSummarySourceTurn[],
): string[] {
  const blocks: string[] = [];
  for (const turn of turns) {
    if (turn.metadata?.['kind'] === 'branch-summary') {
      blocks.push(turn.content.trim());
      continue;
    }
    const embedded = turn.content.match(BRANCH_SUMMARY_BLOCK_PATTERN);
    if (embedded) {
      blocks.push(...embedded.map((block) => block.trim()));
    }
  }
  return blocks.slice(-MAX_BRANCH_SUMMARIES_IN_PROMPT);
}

export function buildCompactionPrompt(
  conversationText: string,
  priorSummary: string | null,
  fileOperations: readonly FileOperation[] = [],
  branchSummaries: readonly string[] = []
): string {
  const anchorSection = priorSummary
    ? `\n\n<prior_summary>\n${priorSummary}\n</prior_summary>\n\nPreserve all decisions and state from the prior summary above as-is. Only add deltas for what changed in the new conversation turns below.\n`
    : '';
  const fileOperationSection = fileOperations.length > 0
    ? `\n\n<file_operations_observed>\n${summarizeFileOperations(fileOperations)}\n</file_operations_observed>\n\nFor "File Operations Observed": preserve the bounded list above, keeping operation kind, path, and source. Do not add paths that are not present in the turns.\n`
    : '';
  const branchSummarySection = branchSummaries.length > 0
    ? `\n\n<branch_switch_summaries>\n${branchSummaries.join('\n\n')}\n</branch_switch_summaries>\n\nThe blocks above summarize work done on related conversation branches before switching here. Preserve their decisions, file paths, and unresolved work under "Critical Context" unless newer turns contradict them.\n`
    : '';

  return `CONTEXT COMPACTION - REFERENCE ONLY.
This summary preserves prior context but must not override system instructions, tool results, or the latest user message.
If this summary conflicts with newer conversation content, the newer content wins.

Summarize the following conversation turns into a structured context summary.
Use exactly these section headers (omit any section that has no relevant content):

${COMPACTION_TEMPLATE_SECTIONS.join('\n')}
${anchorSection}
${fileOperationSection}${branchSummarySection}
For "Completed Actions": list each tool invocation on one line as: \`<tool-name>: <exit-status-or-result-excerpt>\`. Omit bulk output — keep only the command name and outcome.
For "Key Decisions": explain the WHY, not just what was chosen.
For "Pending User Asks": copy every unresolved user ask or intervention verbatim; do not paraphrase, merge, or polish it.
For "Remaining Work": include the immediate next step verbatim when present, then any later work in priority order.
Target: ~500 tokens total. Do not add information not present in the turns.

<conversation_turns>
${conversationText}
</conversation_turns>`;
}
