/**
 * Rebuilding a woken session's visible buffer from persisted history.
 *
 * Waking keeps only the newest slice of `conversationHistory`, which discards
 * the opening prompt a second time — and memory-pressure hibernation puts every
 * idle session through this path, so it is the likeliest way a long-running
 * conversation loses the request that started it. The discarded prompts are
 * folded into the instance's retained set rather than dropped.
 */

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import {
  mergeRetainedPrompts,
  promptsDiscardedByTruncation,
  type RetainableHistoryEntry,
} from '../prompt-retention';

/** Messages a waking session restores into its visible buffer. */
export const WAKE_RESTORED_MESSAGES = 50;

export function restoreWokenOutputBuffer(
  instance: Pick<Instance, 'outputBuffer' | 'retainedPrompts'>,
  history: readonly RetainableHistoryEntry[],
  stamp: number,
): void {
  if (history.length === 0) {
    return;
  }

  instance.retainedPrompts = mergeRetainedPrompts(
    instance.retainedPrompts,
    promptsDiscardedByTruncation(history, WAKE_RESTORED_MESSAGES, 'restored-prompt-'),
  );

  // Restore recent messages into the output buffer so the UI can show them.
  instance.outputBuffer = history.slice(-WAKE_RESTORED_MESSAGES).map((entry, idx) => ({
    id: `restored-${idx}-${stamp}`,
    timestamp: entry.timestamp,
    type: (entry.role === 'user' ? 'user'
      : entry.role === 'assistant' ? 'assistant'
      : 'system') as OutputMessage['type'],
    content: entry.content,
  }));
}
