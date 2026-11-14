import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const workerCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('node:worker_threads', () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      workerCalls.push(args);
    }
    on(): this {
      return this;
    }
    postMessage(): void {
      // Records are not written in this test.
    }
  },
}));

import { ProviderRuntimeTraceSink, resolveProviderRuntimeTraceFilePath } from './provider-runtime-trace-sink';
import { resolveDefaultTraceFilePath } from './local-trace-exporter';

describe('ProviderRuntimeTraceSink worker start-up', () => {
  it('tells the worker which log file to write', () => {
    // A worker thread cannot ask Electron for the app's folder; without this the
    // worker fell back to the temp folder and its rotated copies piled up there.
    new ProviderRuntimeTraceSink();

    expect(workerCalls).toHaveLength(1);
    expect(workerCalls[0]?.[1]).toMatchObject({
      workerData: { traceFilePath: resolveProviderRuntimeTraceFilePath() },
    });
    expect(resolveProviderRuntimeTraceFilePath()).toBe(
      path.join(path.dirname(resolveDefaultTraceFilePath()), 'provider-runtime-trace.ndjson'),
    );
  });
});
