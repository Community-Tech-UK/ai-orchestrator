/**
 * LT-196: side store for per-tool-call outcome records.
 *
 * The correction miner needs a real `is_error` for every tool call, read from
 * the archived transcript. The obvious place to put that signal was the live
 * `instance.outputBuffer`, since that is what gets archived — and that is what
 * the first implementation did.
 *
 * It was the wrong choice. `outputBuffer` has roughly twenty direct readers
 * across orchestration, automations, channels, sessions and history, and an
 * invisible message sharing a channel with visible ones leaks wherever a
 * reader forgets to filter. Five review rounds found five separate leaks: the
 * Replay/Share page, live mobile broadcast, persisted session continuity, the
 * observation ingestor's vector-store embedding, the plugin host, and — worst
 * — `get_child_output`, which injected raw tool-failure text straight into
 * another agent's live conversation.
 *
 * So the record never enters `outputBuffer` at all. It is held here, keyed by
 * instance, and merged into the transcript only at archive assembly
 * (`HistoryManager.getCompleteArchiveMessages`), which is the one place the
 * miner reads from. Every `outputBuffer` consumer is then safe by
 * construction rather than by remembering to filter, and no future consumer
 * can regress it.
 *
 * Kept out of the `Instance` object deliberately: a field there would flow
 * into DTOs, serializers and persistence snapshots, recreating the same class
 * of accidental exposure this store exists to end.
 */

import type { OutputMessage } from '../../shared/types/instance.types';

/**
 * Per-instance cap. A correction pair needs a failure and its fix, both of
 * which are recent; retaining an unbounded history would grow with a long
 * session for no benefit. Oldest records are dropped first.
 */
export const MAX_TOOL_OUTCOMES_PER_INSTANCE = 2000;

/**
 * Backstop cap on tracked instances. Records are normally dropped when their
 * instance is archived, but a crash, a never-archived instance, or a future
 * teardown path that forgets to clear would otherwise grow this map for the
 * app's lifetime. `Map` preserves insertion order, so the oldest instance is
 * evicted first.
 */
export const MAX_TRACKED_INSTANCES = 50;

const outcomesByInstance = new Map<string, OutputMessage[]>();

/** Record one outcome. Called instead of appending to `instance.outputBuffer`. */
export function recordToolOutcome(instanceId: string, message: OutputMessage): void {
  const existing = outcomesByInstance.get(instanceId);
  if (!existing) {
    if (outcomesByInstance.size >= MAX_TRACKED_INSTANCES) {
      const oldest = outcomesByInstance.keys().next().value;
      if (oldest !== undefined) outcomesByInstance.delete(oldest);
    }
    outcomesByInstance.set(instanceId, [message]);
    return;
  }
  existing.push(message);
  if (existing.length > MAX_TOOL_OUTCOMES_PER_INSTANCE) {
    existing.splice(0, existing.length - MAX_TOOL_OUTCOMES_PER_INSTANCE);
  }
}

/** The records held for an instance, oldest first. Empty when there are none. */
export function getToolOutcomes(instanceId: string): readonly OutputMessage[] {
  return outcomesByInstance.get(instanceId) ?? [];
}

/**
 * Drop an instance's records. Called once its transcript has been archived, and
 * on instance removal, so a long-lived app does not accumulate them.
 */
export function clearToolOutcomes(instanceId: string): void {
  outcomesByInstance.delete(instanceId);
}

export function _resetToolOutcomeStoreForTesting(): void {
  outcomesByInstance.clear();
}
