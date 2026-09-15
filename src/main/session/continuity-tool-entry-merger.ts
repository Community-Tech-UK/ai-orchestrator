/**
 * One continuity entry per tool call and per tool result.
 *
 * A tool call reaches continuity from two sources: the visible `tool_use` /
 * `tool_result` output message, and the raw `tool_use` / `tool_result` adapter
 * event that loop detection consumes. Both are projected
 * (`continuity-message-projection.ts`), under different ids, so an adapter that
 * emits both — the ACP adapter does for every call — stored each call and
 * each result twice. A woken session then restored every tool card twice.
 *
 * Neither source can simply be dropped: Claude reports ordinary tool results
 * only through the raw event, and the raw call carries the fuller input. So
 * entries are merged by call id instead. The first source to arrive creates the
 * entry and the other is folded into it, keeping its position. The visible
 * message wins where both have a value, since it is what the user saw and it
 * carries `is_error`.
 *
 * Each source contributes once per call. A second raw event, or a second
 * message under a different id, for a call that already has one is taken as a
 * new call reusing the id, not merged into the old one. Callers scope keys by
 * adapter generation so a respawned adapter that restarts its numbering never
 * matches the previous run's calls; the raw call's stored id carries the
 * generation too (`continuity-message-projection.ts`), so it cannot overwrite
 * the earlier call when continuity replaces entries by id.
 */

import { isDeepStrictEqual } from 'node:util';
import type { ConversationEntry } from './session-continuity.types';

export type ContinuityToolEntryDecision =
  | { kind: 'add'; entryId: string; entry: ConversationEntry }
  /** `entry` is the whole merged entry, for re-adding if the target is gone. */
  | { kind: 'patch'; entryId: string; patch: Partial<Omit<ConversationEntry, 'id'>>; entry: ConversationEntry }
  | { kind: 'skip'; entryId: string };

interface RecordedToolEntry {
  entry: ConversationEntry;
  sawMessage: boolean;
  sawRaw: boolean;
}

/** Calls remembered per scope; older ones have long left the persisted history. */
const DEFAULT_MAX_CALLS_PER_SCOPE = 2_000;

function toolKey(entry: ConversationEntry): string | null {
  const toolUse = entry.toolUse;
  if (!toolUse) return null;
  if (toolUse.kind === 'result' || entry.role === 'tool') {
    return toolUse.resultForCallId ? `result:${toolUse.resultForCallId}` : null;
  }
  return toolUse.callId ? `call:${toolUse.callId}` : null;
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** `upper`'s present values over `lower`, keeping `lower`'s id and timestamp. */
function overlay(lower: ConversationEntry, upper: ConversationEntry): ConversationEntry {
  const merged: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(upper)) {
    if (key === 'id' || key === 'timestamp' || key === 'toolUse') continue;
    if (hasValue(value)) merged[key] = value;
  }
  if (lower.toolUse || upper.toolUse) {
    const toolUse: Record<string, unknown> = { ...lower.toolUse };
    for (const [key, value] of Object.entries(upper.toolUse ?? {})) {
      if (hasValue(value)) toolUse[key] = value;
    }
    merged['toolUse'] = toolUse;
  }
  return merged as unknown as ConversationEntry;
}

export class ContinuityToolEntryMerger {
  private readonly byScope = new Map<string, Map<string, RecordedToolEntry>>();

  constructor(private readonly maxCallsPerScope = DEFAULT_MAX_CALLS_PER_SCOPE) {}

  /**
   * @param scope groups calls whose ids can be matched: an instance id plus its
   *   adapter generation for live events.
   * @param fromMessage whether the entry came from a visible output message
   *   rather than a raw adapter tool event.
   */
  merge(scope: string, entry: ConversationEntry, fromMessage: boolean): ContinuityToolEntryDecision {
    const key = toolKey(entry);
    if (!key) return { kind: 'add', entryId: entry.id, entry };

    let recordedByKey = this.byScope.get(scope);
    if (!recordedByKey) {
      recordedByKey = new Map<string, RecordedToolEntry>();
      this.byScope.set(scope, recordedByKey);
    }
    const recorded = recordedByKey.get(key);
    const sameEntry = recorded?.entry.id === entry.id;
    const sourceAlreadySeen = recorded && (fromMessage ? recorded.sawMessage : recorded.sawRaw);
    if (!recorded || (sourceAlreadySeen && !sameEntry)) {
      this.remember(recordedByKey, key, { entry, sawMessage: fromMessage, sawRaw: !fromMessage });
      return { kind: 'add', entryId: entry.id, entry };
    }
    if (sameEntry) {
      // A re-emission (e.g. a streaming update) replaces the entry by id.
      this.remember(recordedByKey, key, { ...recorded, entry });
      return { kind: 'add', entryId: entry.id, entry };
    }

    const merged = fromMessage
      ? overlay(recorded.entry, entry)
      : overlay({ ...entry, id: recorded.entry.id, timestamp: recorded.entry.timestamp }, recorded.entry);
    const entryId = recorded.entry.id;
    this.remember(recordedByKey, key, { entry: merged, sawMessage: true, sawRaw: true });
    if (isDeepStrictEqual(merged, recorded.entry)) {
      return { kind: 'skip', entryId };
    }
    const { id: _id, timestamp: _timestamp, ...patch } = merged;
    return { kind: 'patch', entryId, patch, entry: merged };
  }

  /** Drop every scope belonging to an instance (`<instanceId>` or `<instanceId>:<generation>`). */
  forget(instanceId: string): void {
    for (const scope of [...this.byScope.keys()]) {
      if (scope === instanceId || scope.startsWith(`${instanceId}:`)) this.byScope.delete(scope);
    }
  }

  private remember(recordedByKey: Map<string, RecordedToolEntry>, key: string, value: RecordedToolEntry): void {
    recordedByKey.delete(key);
    recordedByKey.set(key, value);
    if (recordedByKey.size > this.maxCallsPerScope) {
      const oldest = recordedByKey.keys().next().value;
      if (oldest !== undefined) recordedByKey.delete(oldest);
    }
  }
}

/**
 * Collapse raw-event and message copies of the same tool call in a persisted
 * history, for histories written before live merging existed. Raw projections
 * are recognised by their `tool-call:` / `tool-result:` ids.
 */
export function mergeDuplicateToolEntries(history: readonly ConversationEntry[]): {
  entries: ConversationEntry[];
  merged: number;
} {
  const merger = new ContinuityToolEntryMerger(Number.MAX_SAFE_INTEGER);
  const entries: ConversationEntry[] = [];
  const indexById = new Map<string, number>();
  let merged = 0;
  for (const entry of history) {
    const fromRaw = entry.id.startsWith('tool-call:') || entry.id.startsWith('tool-result:');
    const decision = merger.merge('history', entry, !fromRaw);
    if (decision.kind === 'add') {
      const existing = indexById.get(entry.id);
      if (existing !== undefined) {
        entries[existing] = entry;
      } else {
        indexById.set(entry.id, entries.length);
        entries.push(entry);
      }
      continue;
    }
    merged++;
    const index = indexById.get(decision.entryId);
    if (decision.kind === 'patch' && index !== undefined) entries[index] = decision.entry;
  }
  return { entries, merged };
}
