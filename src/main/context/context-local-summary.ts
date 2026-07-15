import type { ConversationTurn } from './context-compactor';
import {
  extractFileOperationsFromTurns,
  summarizeFileOperations,
} from './file-operation-extractor';
import { hasAuthenticatedEvidencePreview } from './microcompact';

/**
 * Generate a local summary without an API call.
 * Uses the same broad shape as LLM-generated summaries and embeds the prior
 * summary as-is when present so previous decisions survive compaction rounds.
 */
export function generateLocalSummary(turns: ConversationTurn[], priorSummary: string | null): string {
  const userMessages = turns.filter(t => t.role === 'user');
  const assistantMessages = turns.filter(t => t.role === 'assistant');

  // Collect user-stated objectives (first user message heuristic)
  const objective = userMessages[0]?.content.slice(0, 200).replace(/\n/g, ' ') ?? '(unknown)';

  // Collect action-intent sentences from all turns
  const actionKeywords = ['implement', 'create', 'fix', 'update', 'add', 'remove', 'change', 'refactor', 'migrate'];
  const actions = new Set<string>();
  for (const turn of turns) {
    for (const kw of actionKeywords) {
      if (turn.content.toLowerCase().includes(kw)) {
        const sentences = turn.content.split(/[.!?\n]/);
        for (const s of sentences) {
          if (s.toLowerCase().includes(kw) && s.trim().length > 10) {
            actions.add(s.trim().slice(0, 120));
            if (actions.size >= 5) break;
          }
        }
      }
      if (actions.size >= 5) break;
    }
  }

  // Collect tool invocations with trimmed outputs
  const toolLines: string[] = [];
  for (const turn of turns) {
    for (const tc of turn.toolCalls ?? []) {
      const result = tc.output
        ? hasAuthenticatedEvidencePreview(tc)
          ? `authenticated evidence ${tc.evidencePreview.evidenceId} retained separately`
          : tc.output.slice(0, 80).replace(/\n/g, ' ')
        : 'no output';
      toolLines.push(`- \`${tc.name}\`: ${result}`);
    }
  }

  const anchorSection = priorSummary
    ? `\n\n*(Anchored from prior compaction)*\n${priorSummary.slice(0, 600)}`
    : '';

  const pendingItems = [...actions].map(a => `- ${a}`).join('\n') || '- (none extracted)';
  const commandsSection = toolLines.length > 0
    ? toolLines.slice(0, 10).join('\n')
    : '- (none)';
  const fileOperations = extractFileOperationsFromTurns(turns);
  const fileOperationsSection = fileOperations.length > 0
    ? `\n\n## File Operations Observed\n${summarizeFileOperations(fileOperations, 40)}`
    : '';

  return `## Objective
${objective}

## Current State
${assistantMessages.length} assistant turns processed, ${userMessages.length} user turns.${anchorSection}

## Pending Work
${pendingItems}

## Commands Run
${commandsSection}${fileOperationsSection}

## Verification Status
(local compaction — no LLM verification available; ${turns.length} turns compacted)`;
}
