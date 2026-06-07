export type SpawnWorkerSignal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';

export interface SpawnWorkerSpawnMsg {
  type: 'spawn';
  id: number;
  instanceId: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  streamIdleTimeoutMs?: number;
  closeStdin?: boolean;
}

export interface SpawnWorkerStdinWriteMsg {
  type: 'stdin-write';
  id: number;
  instanceId: string;
  data: string;
  closeAfterWrite?: boolean;
}

export interface SpawnWorkerSignalMsg {
  type: 'signal';
  instanceId: string;
  signal: SpawnWorkerSignal;
}

export interface SpawnWorkerTerminateMsg {
  type: 'terminate';
  id: number;
  instanceId: string;
  graceful: boolean;
}

export interface SpawnWorkerShutdownMsg {
  type: 'shutdown';
  id: number;
}

export type SpawnWorkerInboundMsg =
  | SpawnWorkerSpawnMsg
  | SpawnWorkerStdinWriteMsg
  | SpawnWorkerSignalMsg
  | SpawnWorkerTerminateMsg
  | SpawnWorkerShutdownMsg;

export type SpawnWorkerOutboundMsg =
  | { type: 'ready' }
  | { type: 'rpc-response'; id: number; result?: unknown; error?: string }
  | { type: 'spawned'; instanceId: string; pid: number }
  | { type: 'stdout-chunk'; instanceId: string; chunk: string }
  | { type: 'stderr-chunk'; instanceId: string; chunk: string }
  | { type: 'exited'; instanceId: string; code: number | null; signal: string | null }
  | { type: 'stream-idle'; instanceId: string; timeoutMs: number }
  | { type: 'epipe'; instanceId: string; pipe: 'stdin' | 'stdout' };
