import type {
  BackgroundJobLane,
  BackgroundJobRecord,
  LaneDegradedEvent,
  LaneGatewayMetrics,
  LaneHeartbeatEvent,
  LaneProgressEvent,
} from './types';

export interface LaneGateway {
  readonly lane: BackgroundJobLane;
  start(): Promise<void>;
  stop(): Promise<void>;
  runJob(job: BackgroundJobRecord, payload: unknown): Promise<unknown>;
  cancelJob(jobId: string): Promise<void>;
  getMetrics(): LaneGatewayMetrics;
  on(event: 'progress', listener: (event: LaneProgressEvent) => void): this;
  on(event: 'heartbeat', listener: (event: LaneHeartbeatEvent) => void): this;
  on(event: 'degraded', listener: (event: LaneDegradedEvent) => void): this;
}

export type {
  BackgroundJobLane,
  BackgroundJobRecord,
  LaneDegradedEvent,
  LaneGatewayMetrics,
  LaneHeartbeatEvent,
  LaneProgressEvent,
};
