/**
 * Provider-level activity signal — what the agent is actually doing right now.
 * This is separate from InstanceStatus (orchestrator-level lifecycle state).
 * ActivityState informs InstanceStatus transitions but doesn't replace it.
 */
export type ActivityState = 'active' | 'ready' | 'idle' | 'waiting_input' | 'blocked' | 'exited';

/** A single recorded activity entry (persisted to .ao/activity.jsonl) */
export interface ActivityEntry {
  /** Epoch ms when this state was observed */
  ts: number;
  /** Detected activity state */
  state: ActivityState;
  /** How this state was detected */
  source: 'native' | 'terminal' | 'process-check';
  /** Last 3 lines of terminal output for debugging (only for terminal source) */
  trigger?: string;
  /** Which provider reported this */
  provider?: string;
}

/** Result from the detection cascade — includes confidence from which fallback level produced it */
export interface ActivityDetectionResult {
  /** Detected state */
  state: ActivityState;
  /** Which fallback level produced this result */
  confidence: 'high' | 'medium' | 'low';
  /** How long until this result should be considered stale (ms) */
  staleAfterMs: number;
  /** Human-readable description of which detection method succeeded */
  source: string;
}

/** Thresholds and constants for activity detection */
export const ACTIVITY_CONSTANTS = {
  /** Activity younger than this = 'active' */
  ACTIVE_WINDOW_MS: 30_000,
  /** Activity 30s–5min old = 'ready', older = 'idle' */
  READY_THRESHOLD_MS: 300_000,
  /** waiting_input/blocked entries older than this decay to idle */
  ACTIVITY_INPUT_STALENESS_MS: 300_000,
  /** Non-actionable state dedup interval for JSONL writes */
  DEDUP_WINDOW_MS: 20_000,
  /** Rotation threshold for activity.jsonl */
  ACTIVITY_LOG_MAX_BYTES: 1_048_576,
  /** Number of rotated files to keep */
  ACTIVITY_LOG_MAX_ROTATED: 3,
} as const;
