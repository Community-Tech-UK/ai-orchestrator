import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { InstrumentationScope } from '@opentelemetry/core';
import type { Resource } from '@opentelemetry/resources';
import { LocalTraceFileExporter } from '../local-trace-exporter';

const tempDirs: string[] = [];

function createSpan(name: string): ReadableSpan {
  const startedAt = [1_700_000_000, 100_000_000] as const;
  const endedAt = [1_700_000_000, 250_000_000] as const;
  return {
    name,
    kind: 0,
    spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1', traceFlags: 1, isRemote: false }),
    parentSpanContext: undefined,
    startTime: [...startedAt],
    endTime: [...endedAt],
    status: { code: 1 },
    attributes: { 'test.attribute': 'value' },
    links: [],
    events: [],
    duration: [0, 150_000_000],
    ended: true,
    resource: {
      attributes: { 'service.name': 'test-service' },
      async waitForAsyncAttributes() {},
    } as unknown as Resource,
    instrumentationScope: { name: 'test-scope' } as InstrumentationScope,
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

function exportSpans(exporter: LocalTraceFileExporter, spans: ReadableSpan[]): Promise<void> {
  return new Promise((resolve, reject) => {
    exporter.export(spans, (result) => {
      if (result.error) {
        reject(result.error);
        return;
      }
      resolve();
    });
  });
}

describe('LocalTraceFileExporter', () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('writes spans as NDJSON records', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exporter-'));
    tempDirs.push(dir);
    const traceFilePath = path.join(dir, 'traces.ndjson');
    const exporter = new LocalTraceFileExporter(traceFilePath);

    await exportSpans(exporter, [createSpan('orchestration.verification'), createSpan('orchestration.debate')]);
    await exporter.forceFlush();

    const contents = await fs.readFile(traceFilePath, 'utf8');
    const records = contents.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(expect.objectContaining({
      name: 'orchestration.verification',
      traceId: 'trace-1',
      spanId: 'span-1',
    }));
    expect(records[1]).toEqual(expect.objectContaining({
      name: 'orchestration.debate',
    }));
  });

  it('redacts secret-shaped span attributes before writing (Task 14)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-exporter-'));
    tempDirs.push(dir);
    const traceFilePath = path.join(dir, 'traces.ndjson');
    const exporter = new LocalTraceFileExporter(traceFilePath);

    const span = createSpan('provider.runtime_event');
    (span.attributes as Record<string, unknown>)['authorization'] = 'Bearer abcdef1234567890ghijkl';
    (span.attributes as Record<string, unknown>)['error.message'] = 'failed calling sk-1234567890abcdefghij';
    (span.attributes as Record<string, unknown>)['ai.provider.model'] = 'claude-opus';

    await exportSpans(exporter, [span]);
    await exporter.forceFlush();

    const contents = await fs.readFile(traceFilePath, 'utf8');
    expect(contents).not.toContain('abcdef1234567890');
    expect(contents).not.toContain('sk-1234567890');
    const record = JSON.parse(contents.trim()) as { attributes: Record<string, unknown> };
    expect(record.attributes['authorization']).toBe('<redacted-secret>');
    expect(record.attributes['ai.provider.model']).toBe('claude-opus');
  });
});
