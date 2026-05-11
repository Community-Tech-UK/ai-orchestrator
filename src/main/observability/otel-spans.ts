/**
 * OpenTelemetry Span Helpers
 *
 * Provides typed wrappers for tracing orchestration operations:
 * verification, debate, and instance lifecycle.
 */

import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { getOrchestratorTracer } from './otel-setup';

async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getOrchestratorTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function traceVerification<T>(
  verificationId: string,
  meta: { query?: string; agentCount?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    'orchestration.verification',
    {
      'verification.id': verificationId,
      ...(meta.agentCount !== undefined && { 'verification.agent_count': meta.agentCount }),
      ...(meta.query && { 'verification.query': meta.query }),
    },
    () => fn(),
  );
}

export function traceDebate<T>(
  debateId: string,
  meta: { topic?: string; rounds?: number },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    'orchestration.debate',
    {
      'debate.id': debateId,
      ...(meta.rounds !== undefined && { 'debate.rounds': meta.rounds }),
      ...(meta.topic && { 'debate.topic': meta.topic }),
    },
    () => fn(),
  );
}

export function traceInstanceLifecycle<T>(
  operation: string,
  instanceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `instance.${operation}`,
    {
      'instance.id': instanceId,
      'instance.operation': operation,
    },
    () => fn(),
  );
}

/**
 * Records a provider runtime event as an OTel span only for diagnostic event kinds.
 * High-frequency output/tool events are routed to the ProviderRuntimeTraceSink
 * (worker-backed NDJSON) instead of OTel to avoid creating one span per chunk.
 */
export function recordProviderRuntimeEventSpan(envelope: ProviderRuntimeEventEnvelope): void {
  const event = envelope.event;

  // Only record OTel spans for low-frequency diagnostic events.
  // Output, tool_use, tool_result, status, spawned → written to NDJSON trace file.
  if (
    event.kind !== 'error' &&
    event.kind !== 'complete' &&
    event.kind !== 'context' &&
    event.kind !== 'exit'
  ) {
    return;
  }

  const attributes: Record<string, string | number | boolean> = {
    'provider.name': envelope.provider,
    'provider.event_kind': event.kind,
    'instance.id': envelope.instanceId,
  };

  if (envelope.model) {
    attributes['ai.provider.model'] = envelope.model;
  }
  if ('requestId' in event && event.requestId) {
    attributes['ai.provider.request_id'] = event.requestId as string;
  }
  if ('stopReason' in event && event.stopReason) {
    attributes['ai.provider.stop_reason'] = event.stopReason as string;
  }
  if ('rateLimit' in event && (event as { rateLimit?: { remaining?: number } }).rateLimit?.remaining !== undefined) {
    attributes['ai.provider.rate_limit.remaining'] = (event as { rateLimit: { remaining: number } }).rateLimit.remaining;
  }
  if ('quota' in event && (event as { quota?: { exhausted?: boolean } }).quota?.exhausted !== undefined) {
    attributes['ai.provider.quota.exhausted'] = (event as { quota: { exhausted: boolean } }).quota.exhausted;
  }

  const span = getOrchestratorTracer().startSpan('provider.runtime_event', { attributes });
  span.end();
}
