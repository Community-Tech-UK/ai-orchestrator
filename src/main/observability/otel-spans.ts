/**
 * OpenTelemetry Span Helpers
 *
 * Provides typed wrappers for tracing orchestration operations:
 * verification, debate, and instance lifecycle.
 */

import { SpanStatusCode, type Span } from '@opentelemetry/api';
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
