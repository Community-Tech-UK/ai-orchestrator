import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  recordProviderRuntimeEventSpan,
  traceDebate,
  traceInstanceLifecycle,
  traceVerification,
} from '../otel-spans';

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

  it('creates span for verification with correct name and attributes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await traceVerification('v-1', { query: 'Is this safe?', agentCount: 3 }, async () => {});

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('orchestration.verification');
    expect(spans[0].attributes['verification.id']).toBe('v-1');
    expect(spans[0].attributes['verification.agent_count']).toBe(3);
    expect(spans[0].attributes['verification.query']).toBe('Is this safe?');
  });

  it('omits optional verification attributes when not provided', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await traceVerification('v-2', {}, async () => {});

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0].attributes['verification.agent_count']).toBeUndefined();
    expect(spans[0].attributes['verification.query']).toBeUndefined();
  });

  it('creates span for debate with correct name and attributes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await traceDebate('d-1', { topic: 'Architecture', rounds: 4 }, async () => {});

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('orchestration.debate');
    expect(spans[0].attributes['debate.id']).toBe('d-1');
    expect(spans[0].attributes['debate.rounds']).toBe(4);
    expect(spans[0].attributes['debate.topic']).toBe('Architecture');
  });

  it('creates span for instance lifecycle with correct name and attributes', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await traceInstanceLifecycle('create', 'inst-1', async () => {});

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('instance.create');
    expect(spans[0].attributes['instance.id']).toBe('inst-1');
    expect(spans[0].attributes['instance.operation']).toBe('create');
  });

  it('propagates errors and still ends the span', async () => {
    const boom = new Error('boom');

    await expect(
      traceVerification('v-err', {}, async () => {
        throw boom;
      }),
    ).rejects.toThrow('boom');

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('orchestration.verification');
  });

  it('returns the value produced by the wrapped function', async () => {
    const result = await traceDebate('d-2', {}, async () => 42);

    await provider.forceFlush();
    expect(result).toBe(42);
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
