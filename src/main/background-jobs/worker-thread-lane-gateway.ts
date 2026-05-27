import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  ProcessLaneGateway,
  type LaneProcessHandle,
  type ProcessLaneGatewayOptions,
} from './process-lane-gateway';
import type { BackgroundJobLane } from './types';

export interface WorkerThreadLaneGatewayOptions {
  lane: BackgroundJobLane;
  entrypoint: string;
  workerFactory?: () => LaneProcessHandle;
  requestTimeoutMs?: number;
  restartBackoffMs?: number;
  maxRestarts?: number;
}

export class WorkerThreadLaneGateway extends ProcessLaneGateway {
  constructor(options: WorkerThreadLaneGatewayOptions) {
    const processOptions: ProcessLaneGatewayOptions = {
      lane: options.lane,
      entrypoint: options.entrypoint,
      requestTimeoutMs: options.requestTimeoutMs,
      restartBackoffMs: options.restartBackoffMs,
      maxRestarts: options.maxRestarts,
      processFactory: options.workerFactory ?? (() => createWorker(options.entrypoint)),
    };
    super(processOptions);
  }
}

function createWorker(entrypoint: string): LaneProcessHandle {
  const resolved = resolveEntrypoint(entrypoint);
  return new Worker(resolved, {
    execArgv: resolved.endsWith('.ts') ? ['--import', 'tsx'] : [],
  }) as unknown as LaneProcessHandle;
}

function resolveEntrypoint(entrypoint: string): string {
  if (existsSync(entrypoint)) return entrypoint;
  const tsEntrypoint = entrypoint.replace(/\.js$/, '.ts');
  if (existsSync(tsEntrypoint)) return tsEntrypoint;
  const localJs = path.join(__dirname, path.basename(entrypoint));
  if (existsSync(localJs)) return localJs;
  const localTs = localJs.replace(/\.js$/, '.ts');
  if (existsSync(localTs)) return localTs;
  return entrypoint;
}
