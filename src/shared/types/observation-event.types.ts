/**
 * Structured "decision log" events extracted from a session transcript at
 * restart-with-summary compaction time (token/memory plan Tasks 8-9).
 *
 * Keyed by AIO instance id — the compaction runtime works on live instances,
 * not RLM session objects. `compactionMarkerId` is optional because the marker
 * row is written only after compaction completes.
 */

export type ObservationEventType =
  | 'decision'
  | 'discovery'
  | 'error'
  | 'tool_result'
  | 'task_progress'
  | 'preference';

/** 1 = critical, 2 = important, 3 = informational. */
export type ObservationEventPriority = 1 | 2 | 3;

export interface ObservationEvent {
  id: string;
  instanceId: string;
  compactionMarkerId?: string;
  /** Timestamp (ms) of the source message. */
  timestamp: number;
  /** Index of the source message in the transcript that was scanned. */
  turn: number;
  type: ObservationEventType;
  priority: ObservationEventPriority;
  /** One short, secret-redacted line. */
  content: string;
  metadata?: Record<string, string>;
  sourceType: 'heuristic' | 'llm_extracted';
}
