import type { OutputMessage } from '../../core/state/instance/instance.types';

/**
 * Metadata `kind` values written by the loop machinery when it appends user-role
 * events to the chat ledger. Mirrors the literals emitted by
 * `buildLoopStartChatEvent` and `buildLoopInterveneChatEvent` in
 * `src/main/orchestration/loop-chat-summary.ts`.
 *
 * Kept in sync by convention rather than a shared constant: those literals live
 * across the main/renderer process boundary and don't have a single source of
 * truth import.
 */
const LOOP_ORIGINATED_KINDS = new Set(['loop-start', 'loop-intervene']);

export function isLoopOriginatedUserMessage(
  message: Pick<OutputMessage, 'type' | 'metadata'>,
): boolean {
  if (message.type !== 'user') {
    return false;
  }
  const kind = message.metadata?.['kind'];
  return typeof kind === 'string' && LOOP_ORIGINATED_KINDS.has(kind);
}
