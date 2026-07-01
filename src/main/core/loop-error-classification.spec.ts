import { describe, expect, it, vi } from 'vitest';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { FailoverError } from './failover-error';
import { classifyLoopError } from './loop-error-classification';

function errorWithProviderFields(
  message: string,
  fields: {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    code?: string | number;
  } = {},
): Error {
  const error = new Error(message) as Error & {
    status?: number;
    body?: string;
    headers?: Record<string, string>;
    code?: string | number;
  };
  if (fields.status !== undefined) error.status = fields.status;
  if (fields.body !== undefined) error.body = fields.body;
  if (fields.headers !== undefined) error.headers = fields.headers;
  if (fields.code !== undefined) error.code = fields.code;
  return error;
}

describe('classifyLoopError', () => {
  it('does not mistake unsupported max_tokens 400s for context overflow', () => {
    const classified = classifyLoopError(
      errorWithProviderFields('Bad request', {
        status: 400,
        body: 'Unsupported parameter: max_tokens is not supported with this model.',
      }),
      { provider: 'openai', model: 'gpt-test' },
    );

    expect(classified.reason).toBe('validation');
    expect(classified.category).toBe(ErrorCategory.VALIDATION);
    expect(classified.axes).toEqual({
      retryable: false,
      shouldCompress: false,
      shouldFailover: false,
      rotateCredential: false,
    });
    expect(classified.retryAfterMs).toBeNull();
  });

  it('routes real context overflows to compression without generic retry', () => {
    const classified = classifyLoopError(
      errorWithProviderFields('Request too large', {
        status: 400,
        body: "This model's maximum context length is 200000 tokens. However, your messages resulted in 220001 tokens.",
      }),
      { provider: 'openai', model: 'gpt-test' },
    );

    expect(classified.reason).toBe('context_overflow');
    expect(classified.category).toBe(ErrorCategory.RESOURCE);
    expect(classified.axes.retryable).toBe(false);
    expect(classified.axes.shouldCompress).toBe(true);
    expect(classified.axes.shouldFailover).toBe(false);
    expect(classified.serverWindowTokens).toBe(200000);
  });

  it('treats 402 reset-window quota messages as retryable rate limits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)));

    const classified = classifyLoopError(
      errorWithProviderFields('Payment required', {
        status: 402,
        body: 'Usage limit reached; quota resets at 2026-01-01T00:20:00.000Z.',
        headers: { 'Retry-After': '900' },
      }),
      { provider: 'claude', model: 'opus-test' },
    );

    expect(classified.reason).toBe('rate_limit');
    expect(classified.category).toBe(ErrorCategory.RATE_LIMITED);
    expect(classified.axes.retryable).toBe(true);
    expect(classified.axes.rotateCredential).toBe(true);
    expect(classified.retryAfterMs).toBe(900_000);

    vi.useRealTimers();
  });

  it('classifies 5xx provider failures as retryable transient errors', () => {
    const classified = classifyLoopError(
      errorWithProviderFields('Internal server error', { status: 503 }),
      { provider: 'gemini', model: 'pro-test' },
    );

    expect(classified.reason).toBe('unknown');
    expect(classified.category).toBe(ErrorCategory.TRANSIENT);
    expect(classified.axes.retryable).toBe(true);
    expect(classified.axes.shouldCompress).toBe(false);
  });

  it('keeps failover independent from retryability for safety refusals', () => {
    const classified = classifyLoopError(
      errorWithProviderFields('Refused by safety policy: disallowed content'),
      { provider: 'local', model: 'guarded-test' },
    );

    expect(classified.category).toBe(ErrorCategory.PERMISSION);
    expect(classified.axes.retryable).toBe(false);
    expect(classified.axes.shouldFailover).toBe(true);
    expect(classified.axes.rotateCredential).toBe(false);
  });

  it('does not classify generic permission-required errors as billing', () => {
    const classified = classifyLoopError(
      errorWithProviderFields('permission required before running this command'),
      { provider: 'codex', model: 'gpt-test' },
    );

    expect(classified.reason).toBe('permission');
    expect(classified.category).toBe(ErrorCategory.PERMISSION);
    expect(classified.axes.rotateCredential).toBe(false);
  });

  it('preserves existing FailoverError reasons while adding loop axes', () => {
    const classified = classifyLoopError(
      new FailoverError('Provider adapter failed while invoking model', {
        reason: 'provider_runtime',
        provider: 'codex',
        model: 'gpt-test',
      }),
    );

    expect(classified.reason).toBe('provider_runtime');
    expect(classified.category).toBe(ErrorCategory.PROVIDER_RUNTIME);
    expect(classified.axes.retryable).toBe(true);
    expect(classified.axes.shouldFailover).toBe(true);
  });
});
