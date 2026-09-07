/**
 * LT-196: transcript-invisible per-tool-call outcome record.
 *
 * The correction miner (`src/main/learning/correction-miner.ts`) mines the
 * archived `OutputMessage[]` transcript for command-failed-then-corrected
 * pairs, and needs a real `is_error` boolean per tool call. Two of the three
 * live emit paths stopped supplying one:
 *
 *  - Claude raw-emits tool results on an internal `EventEmitter` only and
 *    writes no visible `tool_result` message (LT-062, deliberately — the
 *    transcript-noise removal that fix was for must not be undone).
 *  - `AcpCliAdapter` (Copilot, Cursor, Grok) writes a `tool_result` whose
 *    metadata carries a `status` string but no `is_error` key at all.
 *
 * Rather than reintroduce visible tool noise, Claude emits one `tool_outcome`
 * message at the point where it already knows the real outcome. ACP does not:
 * it sets `is_error` on its own visible `tool_result` instead, and only falls
 * back to this record when a terminal call rendered no output at all (see
 * `buildAcpToolOutcomeFallback`). It rides the existing `HistoryManager` archive pipeline unchanged
 * and is suppressed centrally in the renderer, so it never becomes a chat
 * bubble. Codex already sets `is_error` correctly and is left alone.
 */

import type { OutputMessage } from './instance.types';

/** Metadata keys carried by a `tool_outcome` record. */
export const TOOL_OUTCOME_METADATA = {
  toolUseId: 'tool_use_id',
  isError: 'is_error',
  toolName: 'name',
} as const;

/**
 * Cap on the error text carried by a failure record. The miner classifies an
 * error from this text (`classifyError(failInv.resultText)`), which only ever
 * inspects the leading portion, so a truncated copy is sufficient and keeps
 * the archived transcript from growing by the size of every tool result.
 */
export const TOOL_OUTCOME_RESULT_TEXT_LIMIT = 2000;

export interface ToolOutcomeInput {
  /** Correlation id matching the originating `tool_use` message. */
  toolUseId: string;
  /** True when the tool call failed. */
  isError: boolean;
  /** Tool name, when the adapter has it. */
  toolName?: string;
  /**
   * The tool's result text. Only retained for failures — the miner needs it to
   * classify the error, and a success carries no signal worth storing.
   */
  resultText?: string;
}

/**
 * Builds the outcome record. `content` carries truncated error text on a
 * failure and is empty on success — nothing renders this message, and the
 * transcript should not grow by the size of every successful tool result.
 *
 * The command string is deliberately NOT carried: the miner reads it from the
 * paired `tool_use` message, which every adapter still emits visibly.
 */
export function buildToolOutcomeMessage(
  input: ToolOutcomeInput,
  id: string,
  timestamp: number,
): OutputMessage {
  const metadata: Record<string, unknown> = {
    [TOOL_OUTCOME_METADATA.toolUseId]: input.toolUseId,
    [TOOL_OUTCOME_METADATA.isError]: input.isError,
  };
  if (input.toolName !== undefined) metadata[TOOL_OUTCOME_METADATA.toolName] = input.toolName;
  const content = input.isError && input.resultText
    ? input.resultText.slice(0, TOOL_OUTCOME_RESULT_TEXT_LIMIT)
    : '';
  return { id, timestamp, type: 'tool_outcome', content, metadata };
}

/** True for a `tool_outcome` record. Used by the renderer to suppress it. */
export function isToolOutcomeMessage(message: { type: string }): boolean {
  return message.type === 'tool_outcome';
}

/** An `OutputMessage` that is not the invisible outcome record. */
export type VisibleOutputMessage = OutputMessage & {
  type: Exclude<OutputMessage['type'], 'tool_outcome'>;
};

/**
 * Narrowing predicate for boundaries that expose the transcript to consumers
 * which have no `tool_outcome` representation (the mobile DTO, agent-facing
 * node-output reads). Use as `buffer.filter(isVisibleOutputMessage)`.
 */
export function isVisibleOutputMessage(message: OutputMessage): message is VisibleOutputMessage {
  return message.type !== 'tool_outcome';
}
