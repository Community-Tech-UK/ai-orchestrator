import { describe, expect, it, vi } from 'vitest';
import type { AcpJsonRpcErrorResponse } from '../../../shared/types/cli.types';
import { settleAcpErrorResponse } from './acp-jsonrpc-errors';
import { toJsonSafeProviderEventPayload } from '../../providers/provider-event-raw-payload';

function settle(error: AcpJsonRpcErrorResponse['error']) {
  const reject = vi.fn<(error: Error) => void>();
  const timer = setTimeout(() => undefined, 1_000);
  const pending = new Map([['7', { method: 'session/prompt', timer, reject }]]);
  settleAcpErrorResponse({ jsonrpc: '2.0', id: 7, error }, pending, () => undefined);
  clearTimeout(timer);
  const failure = reject.mock.calls[0]![0];
  return { failure, ledgerPayload: toJsonSafeProviderEventPayload(failure) as { cause: Record<string, unknown> } };
}

describe('settleAcpErrorResponse capture', () => {
  it('keeps a supplied HTTP status and decoded body through projection and redaction (placeholder values only)', () => {
    const body = { error: { code: '429', message: 'quota exhausted', type: 'limitation' } };
    const { failure, ledgerPayload } = settle({
      code: -32603, message: 'Internal error',
      data: { statusCode: 429, responseBody: JSON.stringify(body), apiKey: 'placeholder-not-a-key' },
    });
    expect(failure.message).toBe('ACP session/prompt failed: Internal error (-32603)');
    const error = ledgerPayload.cause['error'] as { data: Record<string, unknown> };
    expect(error.data['statusCode']).toBe(429);
    expect(error.data['responseBody']).toEqual(body);
    expect(error.data['apiKey']).not.toBe('placeholder-not-a-key');
    expect(ledgerPayload.cause).not.toHaveProperty('upstreamHttp');
  });

  it('names the missing HTTP status and body for the real OpenCode quota reply (data present, no HTTP fields)', () => {
    // Shape observed live from OpenCode 1.19.5 on 2026-11-13: only a service and error name.
    const data = { service: 'session', errorName: 'APIError' };
    const { ledgerPayload } = settle({ code: -32603, message: 'Internal error: quota exhausted', data });
    expect(ledgerPayload.cause['error']).toEqual({ code: -32603, message: 'Internal error: quota exhausted', data });
    expect(ledgerPayload.cause['upstreamHttp']).toEqual({ status: 'not-supplied-by-acp', body: 'not-supplied-by-acp' });
    expect(JSON.stringify(ledgerPayload)).not.toContain('429');
  });

  it('names both as missing when the reply has no data at all, and only the missing one when one is supplied', () => {
    const none = settle({ code: -32603, message: 'Internal error: quota exhausted' }).ledgerPayload.cause;
    expect(none['error']).toEqual({ code: -32603, message: 'Internal error: quota exhausted' });
    expect(none['upstreamHttp']).toEqual({ status: 'not-supplied-by-acp', body: 'not-supplied-by-acp' });
    const statusOnly = settle({ code: -32603, message: 'Internal error', data: { nested: { status: 429 } } }).ledgerPayload.cause;
    expect(statusOnly['upstreamHttp']).toEqual({ body: 'not-supplied-by-acp' });
  });
});
