import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { observeAdapterRuntimeEvents } from '../providers/adapter-runtime-event-bridge';
import { InstanceReasoningCollapseContinuation } from '../instance/instance-reasoning-collapse-continuation';
import { InstanceAsyncWorkRegistry } from '../instance/instance-async-work-registry';
import { classifyTurnEnding } from './turn-ending-classifier';
import { readClaudeResultStop, resultMetadata } from './adapters/claude-result-stop';
import { parseClaudeOutput } from './adapters/claude-output-parser';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

const stopReasons = ['aborted_streaming', 'aborted_tools'] as const;

describe('installed Claude interrupted result classification', () => {
  it.each(stopReasons)('recognizes %s without relying on a human-readable result message', (reason) => {
    const stop = readClaudeResultStop({ type: 'result', subtype: 'error_during_execution', terminal_reason: reason, is_error: true });
    const { metadata } = resultMetadata(undefined, stop);
    expect(classifyTurnEnding({ kind: 'complete', metadata: { ...metadata, is_error: true }, raw: {
      type: 'result', subtype: 'error_during_execution', is_error: true,
    } })).toEqual({ reason: 'completed', evidence: 'client_cancelled', autoContinueSuppressed: true });
  });

  it.each(stopReasons)('recognizes the normalized Stop finish %s', (reason) => {
    expect(classifyTurnEnding({ kind: 'complete', metadata: { finish: reason, is_error: true } }))
      .toEqual({ reason: 'completed', evidence: 'client_cancelled', autoContinueSuppressed: true });
  });

  it('retains provider errors without an explicit interruption reason', () => {
    expect(classifyTurnEnding({ kind: 'complete', raw: { type: 'result', subtype: 'error_during_execution', is_error: true } }))
      .toEqual({ reason: 'unknown_error', evidence: 'provider_error' });
  });

  it.each(stopReasons)('does not infer cancellation from source text mentioning %s', (reason) => {
    expect(classifyTurnEnding({ kind: 'error', error: `Unexpected result while checking ${reason} source text` }))
      .toEqual({ reason: 'unknown_error', evidence: 'provider_error' });
  });

  it.each(stopReasons)('passes %s through real provider ingress without an error notice or continuation', (reason) => {
    const adapter = new EventEmitter();
    const events = new EventEmitter();
    const instance = { id: 'stopped-session', status: 'idle', requestCount: 1, parentId: null, launchMode: 'orchestrated', outputBuffer: [] } as unknown as Instance;
    const notice = vi.fn();
    const sendInput = vi.fn(async () => undefined);
    const continuation = new InstanceReasoningCollapseContinuation(new InstanceAsyncWorkRegistry(), {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: () => instance,
      emitSystemMessage: notice, sendInput, waitForInstanceSettled: async () => instance,
    });
    const normalized = vi.fn();
    const unsubscribe = observeAdapterRuntimeEvents(adapter, (event) => {
      normalized(event.event);
      events.emit('provider:normalized-event', {
        eventId: event.eventId, seq: 1, timestamp: event.timestamp, provider: 'claude', instanceId: instance.id,
        event: event.event, raw: { payload: event.rawPayload },
      });
    });
    continuation.start();
    try {
      const raw = { type: 'result', subtype: 'error_during_execution', terminal_reason: reason, is_error: true };
      adapter.emit('complete', parseClaudeOutput(JSON.stringify(raw), 'stopped-response', () => undefined));

      expect(normalized).toHaveBeenCalledWith(expect.objectContaining({ kind: 'complete', finish: reason,
        turnEnding: { reason: 'completed', evidence: 'client_cancelled', autoContinueSuppressed: true } }));
      expect(notice).not.toHaveBeenCalled();
      expect(sendInput).not.toHaveBeenCalled();
    } finally { unsubscribe(); continuation.stop(); }
  });
});
