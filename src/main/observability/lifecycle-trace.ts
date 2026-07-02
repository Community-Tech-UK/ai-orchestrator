import * as fs from 'fs/promises';
import * as path from 'path';
import { redactForSink } from '../diagnostics/redaction';
import { resolveDefaultTraceFilePath } from './local-trace-exporter';

export interface LifecycleTraceEvent {
  correlationId?: string;
  instanceId: string;
  turnId?: string;
  adapterGeneration?: number;
  provider?: string;
  recoveryReason?: string;
  eventType: string;
  previousStatus?: string;
  status?: string;
  errorClass?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

let writeQueue = Promise.resolve();

export function resolveLifecycleTraceFilePath(): string {
  return path.join(path.dirname(resolveDefaultTraceFilePath()), 'lifecycle.ndjson');
}

export function recordLifecycleTrace(
  event: LifecycleTraceEvent,
  traceFilePath = resolveLifecycleTraceFilePath(),
): void {
  const payload = {
    timestamp: event.timestamp ?? Date.now(),
    ...event,
  };
  // Task 14: `metadata`, `errorClass`, and `recoveryReason` are free-form and
  // can echo failing requests (URLs with tokens, auth headers). Redact before
  // the NDJSON line is serialized to disk. Redaction must never break tracing;
  // fall back to the raw payload if it throws on an exotic value.
  let redacted: typeof payload;
  try {
    redacted = redactForSink(payload);
  } catch {
    redacted = payload;
  }
  const line = JSON.stringify(redacted);

  writeQueue = writeQueue
    .catch(() => undefined)
    .then(() => appendTraceLine(traceFilePath, line))
    .catch(() => undefined);
}

export async function flushLifecycleTraces(): Promise<void> {
  await writeQueue;
}

export function _resetLifecycleTraceForTesting(): void {
  writeQueue = Promise.resolve();
}

async function appendTraceLine(traceFilePath: string, line: string): Promise<void> {
  try {
    await writeTraceLine(traceFilePath, line);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return;
    }

    try {
      await writeTraceLine(traceFilePath, line);
    } catch {
      // Lifecycle tracing is diagnostic only and must not affect runtime state.
    }
  }
}

async function writeTraceLine(traceFilePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(traceFilePath), { recursive: true });
  await fs.appendFile(traceFilePath, `${line}\n`, 'utf8');
}
