/**
 * Message protocol between the main process and the watchdog worker thread.
 */

export interface WatchdogHeartbeatMetrics {
  eventLoopLagP95Ms: number;
  eventLoopLagMaxMs: number;
  providerBusEmitted: number;
  providerBusDroppedStatus: number;
  contextWorkerInFlight: number;
  contextWorkerDegraded: boolean;
  indexWorkerInFlight: number;
  indexWorkerDegraded: boolean;
  activeInstanceCount: number;
}

export interface HeartbeatMsg {
  type: 'heartbeat';
  timestamp: number;
  metrics: WatchdogHeartbeatMetrics;
}

export interface WatchdogShutdownMsg {
  type: 'shutdown';
}

export type WatchdogInboundMsg = HeartbeatMsg | WatchdogShutdownMsg;

export interface WatchdogReadyMsg {
  type: 'ready';
}

export type WatchdogOutboundMsg = WatchdogReadyMsg;

// Written to userData/diagnostics/watchdog-report.json when a stall is detected.
export interface WatchdogReport {
  stallDetectedAt: number;
  lastHeartbeatAt: number;
  stalledForMs: number;
  lastMetrics: WatchdogHeartbeatMetrics | null;
  appVersion: string;
}
