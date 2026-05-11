/**
 * Provider Runtime Trace Protocol
 *
 * Clone-safe message types for the main → worker boundary.
 * All values must be serializable via Node.js structured clone.
 */

export interface TraceRecord {
  eventId: string;
  seq: number;
  timestamp: number;
  provider: string;
  instanceId: string;
  sessionId?: string;
  model?: string;
  kind: string;
  /** Compact diagnostic attributes — only non-trivial fields included. */
  attributes?: Record<string, string | number | boolean>;
}

// ── Worker ← Main messages ────────────────────────────────────────────────────

export interface WriteRecordsMessage {
  type: 'write-records';
  records: TraceRecord[];
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type WorkerInboundMessage = WriteRecordsMessage | ShutdownMessage;

// ── Worker → Main messages ────────────────────────────────────────────────────

export interface MetricsMessage {
  type: 'metrics';
  written: number;
  rotations: number;
  errors: number;
  currentFileSizeBytes: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerOutboundMessage = MetricsMessage | WorkerErrorMessage;
