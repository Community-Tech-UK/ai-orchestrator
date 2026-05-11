/**
 * Clone-safe message types for the main-process ↔ log-writer-worker boundary.
 */

export type InitMessage = {
  type: 'init';
  logFile: string;
  maxFileSize: number;
  maxFiles: number;
  currentFileSize: number;
};

export type WriteLinesMessage = {
  type: 'write-lines';
  lines: string[];
};

export type ShutdownMessage = {
  type: 'shutdown';
};

export type WorkerInboundMessage =
  | InitMessage
  | WriteLinesMessage
  | ShutdownMessage;

export type MetricsMessage = {
  type: 'metrics';
  written: number;
  rotations: number;
  errors: number;
};

export type WorkerErrorMessage = {
  type: 'error';
  message: string;
};

export type WorkerOutboundMessage = MetricsMessage | WorkerErrorMessage;
