/**
 * Heuristic decision-log extraction for restart-with-summary compaction
 * (token/memory plan Tasks 8-9), used by `restartCompact` in src/main/app/compaction-runtime.ts.
 *
 * Pure and synchronous: no LLM call. Scans a transcript for explicitly tagged
 * lines, error messages, tool results and todo/next markers, and returns short,
 * secret-redacted, de-duplicated events, bounded to `max`.
 */

import { createHash } from 'node:crypto';
import { redactSecrets as redactDetectedSecrets } from '../security/secret-detector';
import { redactSecrets as redactAssignmentSecrets } from './context-compaction-prompt';
import type {
  ObservationEvent,
  ObservationEventPriority,
  ObservationEventType,
} from '../../shared/types/observation-event.types';

/** First line of the continuity prompt `restartCompact` sends after a restart-with-summary. */
export const CONTINUITY_PACKAGE_MARKER = '[Context Compaction Continuity Package]';

/** The fields of an OutputMessage the extractor reads. */
export interface ObservationSourceMessage {
  type: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ExtractObservationOptions {
  instanceId: string;
  compactionMarkerId?: string;
  /** Maximum events returned (default 30). */
  max?: number;
}

export const DEFAULT_MAX_OBSERVATION_EVENTS = 30;
/** Cap for tool-result summaries, per the plan ("~150 chars"). */
export const TOOL_RESULT_MAX_CHARS = 150;
/** Cap for every other event line. */
export const OBSERVATION_MAX_CHARS = 240;

/**
 * Tag -> event mapping. TODO:/FIXME: are covered by TASK_PATTERN.
 * Tags must be uppercase so ordinary prose ("Error: ...") in chat is not mined.
 */
const TAGS: Record<string, { type: ObservationEventType; priority: ObservationEventPriority }> = {
  DECISION: { type: 'decision', priority: 1 },
  ERROR: { type: 'error', priority: 1 },
  BUG: { type: 'error', priority: 1 },
  ARCHITECTURE: { type: 'decision', priority: 2 },
  IMPORTANT: { type: 'discovery', priority: 2 },
};

const TAG_LINE = /^\s*(?:[-*>]\s*)?(?:\*\*)?(DECISION|ERROR|BUG|ARCHITECTURE|IMPORTANT)(?:\*\*)?:(?:\*\*)?\s*(.+)$/;
/** Same markers the restart prompt's "Unresolved items" block uses. */
const TASK_PATTERN = /^\s*(?:- \[ \]|todo[:-]|next[:-]|follow-up[:-]|fixme[:-])\s*(.+)$/i;

/** Redact first, then collapse whitespace and truncate, so a cut never exposes a secret prefix. */
export function sanitizeObservationText(text: string, maxChars = OBSERVATION_MAX_CHARS): string {
  const redacted = redactAssignmentSecrets(redactDetectedSecrets(text));
  const collapsed = redacted.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 3).trimEnd()}...` : collapsed;
}

function toolNameOf(message: ObservationSourceMessage): string | undefined {
  const name = message.metadata?.['toolName'] ?? message.metadata?.['name'];
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : undefined;
}

export function extractObservationEvents(
  messages: readonly ObservationSourceMessage[],
  options: ExtractObservationOptions,
): ObservationEvent[] {
  const max = Math.max(0, options.max ?? DEFAULT_MAX_OBSERVATION_EVENTS);
  const events: ObservationEvent[] = [];
  const seen = new Set<string>();

  const push = (
    turn: number,
    message: ObservationSourceMessage,
    type: ObservationEventType,
    priority: ObservationEventPriority,
    raw: string,
    maxChars = OBSERVATION_MAX_CHARS,
    metadata?: Record<string, string>,
  ): void => {
    const content = sanitizeObservationText(raw, maxChars);
    if (!content) return;
    const key = `${type}\u0000${content.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    events.push({
      // Deterministic, so re-extracting the same transcript at the next compaction hits the store's
      // ON CONFLICT(id) DO NOTHING instead of inserting the same decision again.
      id: `obs_${createHash('sha256').update([options.instanceId, type, content, message.timestamp ?? 0].join('\u0000')).digest('hex').slice(0, 24)}`,
      instanceId: options.instanceId,
      ...(options.compactionMarkerId ? { compactionMarkerId: options.compactionMarkerId } : {}),
      timestamp: message.timestamp ?? 0,
      turn,
      type,
      priority,
      content,
      ...(metadata ? { metadata } : {}),
      sourceType: 'heuristic',
    });
  };

  messages.forEach((message, turn) => {
    const text = message.content ?? '';
    if (!text.trim()) return;
    // The restart continuity package quotes earlier turns; extracting from it would re-record
    // decisions under a new timestamp once the original message has been trimmed.
    if (text.trimStart().startsWith(CONTINUITY_PACKAGE_MARKER)) return;

    if (message.type === 'error') {
      push(turn, message, 'error', 1, text.split('\n').find((line) => line.trim()) ?? text);
      return;
    }
    if (message.type === 'tool_result') {
      const toolName = toolNameOf(message);
      push(turn, message, 'tool_result', 3, text, TOOL_RESULT_MAX_CHARS, toolName ? { toolName } : undefined);
      return;
    }
    if (message.type !== 'assistant' && message.type !== 'user') return;

    for (const line of text.split('\n')) {
      const tagged = TAG_LINE.exec(line);
      if (tagged) {
        const mapping = TAGS[tagged[1]];
        push(turn, message, mapping.type, mapping.priority, tagged[2], OBSERVATION_MAX_CHARS, { tag: tagged[1] });
        continue;
      }
      const task = TASK_PATTERN.exec(line);
      // Priority 3: the restart prompt already lists these under "Unresolved items".
      if (task) push(turn, message, 'task_progress', 3, task[1]);
    }
  });

  if (events.length <= max) return events;
  // Keep the most important, then the most recent; return in transcript order.
  const kept = new Set(
    [...events]
      .sort((a, b) => a.priority - b.priority || b.turn - a.turn)
      .slice(0, max),
  );
  return events.filter((event) => kept.has(event));
}

/**
 * The "Decision log:" lines for the restart prompt: priority 1-2 events only,
 * newest `limit` of them, in transcript order.
 */
export function selectDecisionLogEntries(events: readonly ObservationEvent[], limit = 10): ObservationEvent[] {
  return events.filter((event) => event.priority <= 2).slice(-limit);
}
