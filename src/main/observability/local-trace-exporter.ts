import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from '@opentelemetry/core';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

function getElectronUserDataPath(): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require('electron');
    return app?.getPath?.('userData');
  } catch {
    return undefined;
  }
}

export function resolveDefaultTraceFilePath(): string {
  const baseDir = getElectronUserDataPath()
    || path.join(os.tmpdir(), 'ai-orchestrator');
  return path.join(baseDir, 'logs', 'traces.ndjson');
}

export class LocalTraceFileExporter implements SpanExporter {
  private writeQueue = Promise.resolve();

  constructor(private readonly traceFilePath = resolveDefaultTraceFilePath()) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const lines = spans.map((span) => JSON.stringify(this.serializeSpan(span))).join('\n');
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.traceFilePath), { recursive: true });
        await fs.appendFile(this.traceFilePath, `${lines}\n`, 'utf8');
        resultCallback({ code: ExportResultCode.SUCCESS });
      })
      .catch((error) => {
        resultCallback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
  }

  async shutdown(): Promise<void> {
    await this.writeQueue;
  }

  async forceFlush(): Promise<void> {
    await this.writeQueue;
  }

  getTraceFilePath(): string {
    return this.traceFilePath;
  }

  private serializeSpan(span: ReadableSpan): Record<string, unknown> {
    const spanContext = span.spanContext();
    return {
      recordedAt: Date.now(),
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      name: span.name,
      kind: span.kind,
      status: span.status,
      startedAtMs: hrTimeToMilliseconds(span.startTime),
      endedAtMs: hrTimeToMilliseconds(span.endTime),
      durationMs: hrTimeToMilliseconds(span.duration),
      attributes: span.attributes,
      events: span.events.map((event) => ({
        name: event.name,
        timeMs: hrTimeToMilliseconds(event.time),
        attributes: event.attributes,
      })),
      links: span.links.map((link) => ({
        traceId: link.context.traceId,
        spanId: link.context.spanId,
        attributes: link.attributes,
      })),
      resource: span.resource.attributes,
      instrumentationScope: {
        name: span.instrumentationScope.name,
        version: span.instrumentationScope.version,
      },
    };
  }
}
