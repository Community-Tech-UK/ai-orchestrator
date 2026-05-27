export type BackgroundJobLane =
  | 'indexing'
  | 'embeddings'
  | 'knowledge-mirror'
  | 'maintenance'
  | 'analysis';

export type BackgroundJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'stale';

export type BackgroundJobPriority =
  | 'user-blocking'
  | 'normal'
  | 'background';

export interface BackgroundJobProgress {
  phase: string;
  completed: number;
  total?: number;
  message?: string;
}

export interface BackgroundJobRecord {
  id: string;
  lane: BackgroundJobLane;
  type: string;
  priority: BackgroundJobPriority;
  coalesceKey?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: BackgroundJobStatus;
  progress?: BackgroundJobProgress;
  errorMessage?: string;
}

export interface BackgroundJobSubmission<TPayload = unknown> {
  lane: BackgroundJobLane;
  type: string;
  priority: BackgroundJobPriority;
  coalesceKey?: string;
  payload: TPayload;
  idempotent?: boolean;
  maxAttempts?: number;
}

export interface BackgroundJobEnqueueResult {
  jobId: string;
  coalesced: boolean;
}

export interface BackgroundJobSnapshot {
  queued: BackgroundJobRecord[];
  running: BackgroundJobRecord[];
  terminal: BackgroundJobRecord[];
}

export interface LaneProgressEvent {
  jobId: string;
  lane: BackgroundJobLane;
  progress: BackgroundJobProgress;
}

export interface LaneHeartbeatEvent {
  lane: BackgroundJobLane;
  timestamp: number;
}

export interface LaneDegradedEvent {
  lane: BackgroundJobLane;
  reason: string;
}

export interface LaneGatewayMetrics {
  degraded: boolean;
  inFlight: number;
  processed: number;
  failed: number;
  restarted: number;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

export type LaneInboundMessage =
  | { type: 'run-job'; jobId: string; jobType: string; payload: unknown }
  | { type: 'cancel-job'; jobId: string }
  | { type: 'get-status' }
  | { type: 'shutdown' };

export type LaneOutboundMessage =
  | { type: 'ready'; lane: BackgroundJobLane }
  | { type: 'job-started'; jobId: string; startedAt: number }
  | { type: 'job-progress'; jobId: string; progress: BackgroundJobProgress }
  | { type: 'job-succeeded'; jobId: string; result?: unknown }
  | { type: 'job-failed'; jobId: string; errorMessage: string }
  | { type: 'job-cancelled'; jobId: string }
  | { type: 'heartbeat'; lane: BackgroundJobLane; timestamp: number };
