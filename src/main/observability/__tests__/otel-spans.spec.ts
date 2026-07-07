import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordProviderRuntimeEventSpan } from '../otel-spans';

describe('otel-spans', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    // disable() resets the proxy tracer cache so the next beforeEach can set a fresh provider
    trace.disable();
    await provider.shutdown();
    exporter.reset();
  });

  it('redacts secret-keyed provider runtime event attributes but keeps operational ones (Task 14)', async () => {
    recordProviderRuntimeEventSpan({
      eventId: 'evt-secret',
      seq: 1,
      timestamp: 1_717_000_000_001,
      provider: 'claude',
      instanceId: 'inst-1',
      model: 'claude-sonnet-4-5',
      event: {
        kind: 'error',
        message: 'rejected Bearer abcdef1234567890ghijkl',
        requestId: 'req_456',
      },
    });

    await provider.forceFlush();
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'provider.runtime_event');

    expect(JSON.stringify(span?.attributes)).not.toContain('abcdef1234567890ghijkl');
    expect(span?.attributes['provider.name']).toBe('claude');
    expect(span?.attributes['ai.provider.request_id']).toBe('req_456');
  });

  it('records provider diagnostics attributes on runtime event spans', async () => {
    recordProviderRuntimeEventSpan({
      eventId: 'evt-1',
      seq: 0,
      timestamp: 1_717_000_000_000,
      provider: 'claude',
      instanceId: 'inst-1',
      model: 'claude-sonnet-4-5',
      event: {
        kind: 'complete',
        requestId: 'req_123',
        stopReason: 'end_turn',
        rateLimit: { remaining: 0 },
        quota: { exhausted: true },
      },
    });

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const span = spans.find((candidate) => candidate.name === 'provider.runtime_event');

    expect(span?.attributes['ai.provider.request_id']).toBe('req_123');
    expect(span?.attributes['ai.provider.model']).toBe('claude-sonnet-4-5');
    expect(span?.attributes['ai.provider.stop_reason']).toBe('end_turn');
    expect(span?.attributes['ai.provider.rate_limit.remaining']).toBe(0);
    expect(span?.attributes['ai.provider.quota.exhausted']).toBe(true);
  });
});
