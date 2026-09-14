/**
 * Rebuilding a woken session's visible buffer from persisted history.
 *
 * Waking keeps only part of `conversationHistory`, which discards the opening
 * prompt a second time — and memory-pressure hibernation puts every idle
 * session through this path, so it is the likeliest way a long-running
 * conversation loses the request that started it. The discarded prompts are
 * folded into the instance's retained set rather than dropped.
 *
 * What is kept matters as much as how much. A newest-N slice was filled by a
 * single burst of tool calls, so every earlier assistant reply vanished from
 * the woken buffer — and from the History archive later built from it — while
 * the user's prompts survived through retention. Tool traffic is therefore
 * shed oldest-first before any conversation is.
 */

import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings-defaults';
import { continuityEntryToOutputMessage } from '../../session/continuity-message-projection';
import type { ConversationEntry } from '../../session/session-continuity.types';
import { mergeRetainedPrompts, promptsFromDiscardedEntries } from '../prompt-retention';

export interface RestoredEntrySelection {
  kept: ConversationEntry[];
  dropped: ConversationEntry[];
}

function isToolTraffic(entry: ConversationEntry): boolean {
  return entry.role === 'tool' || entry.toolUse != null;
}

/**
 * Choose at most `limit` entries to restore, in original order.
 *
 * Drops the oldest tool calls and results first; only when conversation alone
 * exceeds the limit are the oldest conversation entries dropped too. Shedding
 * is by position, not by call/result pair, so the oldest surviving tool result
 * can lack its call.
 */
export function selectRestoredEntries(
  history: readonly ConversationEntry[],
  limit: number,
): RestoredEntrySelection {
  // The settings schema bounds outputBufferSize; a caller passing anything else
  // gets the default rather than an unbounded (NaN) or empty window.
  const window = Number.isFinite(limit) && limit >= 1
    ? Math.floor(limit)
    : DEFAULT_SETTINGS.outputBufferSize;
  let excess = history.length - window;
  if (excess <= 0) {
    return { kept: [...history], dropped: [] };
  }

  const droppedIndexes = new Set<number>();
  for (let i = 0; i < history.length && excess > 0; i++) {
    if (isToolTraffic(history[i])) {
      droppedIndexes.add(i);
      excess--;
    }
  }
  for (let i = 0; i < history.length && excess > 0; i++) {
    if (!droppedIndexes.has(i)) {
      droppedIndexes.add(i);
      excess--;
    }
  }

  const kept: ConversationEntry[] = [];
  const dropped: ConversationEntry[] = [];
  history.forEach((entry, i) => (droppedIndexes.has(i) ? dropped : kept).push(entry));
  return { kept, dropped };
}

/**
 * Restore selected history as typed output messages. Goes through the shared
 * projection so tool calls and results keep their type and metadata instead of
 * collapsing into bare assistant/system text.
 */
export function restoreHistoryMessages(
  entries: readonly ConversationEntry[],
  idFor: (entry: ConversationEntry, index: number) => string,
): OutputMessage[] {
  return entries.map((entry, idx) => ({
    ...continuityEntryToOutputMessage(entry),
    id: idFor(entry, idx),
  }));
}

export function restoreWokenOutputBuffer(
  instance: Pick<Instance, 'outputBuffer' | 'retainedPrompts'>,
  history: readonly ConversationEntry[],
  stamp: number,
  limit: number,
): void {
  if (history.length === 0) {
    return;
  }

  const { kept, dropped } = selectRestoredEntries(history, limit);
  instance.retainedPrompts = mergeRetainedPrompts(
    instance.retainedPrompts,
    promptsFromDiscardedEntries(dropped, 'restored-prompt-'),
  );
  instance.outputBuffer = restoreHistoryMessages(kept, (_, idx) => `restored-${idx}-${stamp}`);
}
