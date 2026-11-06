/**
 * U10: a routine notice is only folded in the transcript if its `audience` flag
 * survives the trip from the emit site to the renderer. Every system message the
 * lifecycle emits goes through `toProviderOutputEvent` and back through
 * `toOutputMessageFromProviderOutputEvent`; both copy `metadata` verbatim, and
 * this pins that so a future whitelist cannot silently drop the flag (which would
 * turn every routine notice back into a full-size attention row).
 *
 * The same trip also writes the default down: a system message nobody flagged
 * leaves with `audience: 'attention'`, whichever way it was produced.
 */

import { describe, expect, it } from 'vitest';
import type { ProviderOutputEvent } from '@contracts/types/provider-runtime-events';
import { toOutputMessageFromProviderOutputEvent, toProviderOutputEvent } from './provider-output-event';
import { ROUTINE_AUDIENCE_METADATA, resolveSystemMessageAudience, resolveSystemMessageSeverity } from '../../shared/utils/system-message-audience';
import type { OutputMessage } from '../../shared/types/instance.types';

describe('routine notice audience across the provider output event', () => {
  it('keeps audience and severity on a system message round trip', () => {
    const message: OutputMessage = {
      id: 'notice-1',
      timestamp: 1_000,
      type: 'system',
      content: 'Interrupted — session restarted (resume failed)',
      metadata: { ...ROUTINE_AUDIENCE_METADATA, severity: 'warning' },
    };

    const restored = toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(message));

    expect(restored.type).toBe('system');
    expect(restored.metadata).toEqual({ audience: 'routine', severity: 'warning' });
    expect(resolveSystemMessageAudience(restored)).toBe('routine');
    expect(resolveSystemMessageSeverity(restored)).toBe('warning');
  });

  it('leaves an unflagged system message as attention', () => {
    const message: OutputMessage = { id: 'notice-2', timestamp: 2_000, type: 'system', content: 'Context usage at 81%.' };

    const restored = toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(message));

    expect(resolveSystemMessageAudience(restored)).toBe('attention');
  });
});

describe('the default audience is explicit at the transport', () => {
  it('writes attention onto a system message that carries no metadata, without touching the original', () => {
    const message: OutputMessage = { id: 'n-1', timestamp: 1, type: 'system', content: 'Context usage at 81%.' };

    const event = toProviderOutputEvent(message);

    expect(event.metadata).toEqual({ audience: 'attention' });
    expect(message.metadata).toBeUndefined();
  });

  it('adds it beside other metadata and leaves that metadata alone', () => {
    const metadata = { autoRespawn: true, recoveryCause: 'stuck' };
    const message: OutputMessage = { id: 'n-2', timestamp: 1, type: 'system', content: 'Session restarted automatically (resume failed)', metadata };

    const event = toProviderOutputEvent(message);

    expect(event.metadata).toEqual({ autoRespawn: true, recoveryCause: 'stuck', audience: 'attention' });
    expect(metadata).toEqual({ autoRespawn: true, recoveryCause: 'stuck' });
  });

  it('keeps a routine audience and an explicit attention exactly as the emit site wrote them', () => {
    const routine = toProviderOutputEvent({ id: 'n-3', timestamp: 1, type: 'system', content: 'a', metadata: { ...ROUTINE_AUDIENCE_METADATA } });
    const attention = toProviderOutputEvent({ id: 'n-4', timestamp: 1, type: 'system', content: 'b', metadata: { audience: 'attention', severity: 'error' } });

    expect(routine.metadata).toEqual({ audience: 'routine' });
    expect(attention.metadata).toEqual({ audience: 'attention', severity: 'error' });
  });

  it('replaces a value that is not an audience instead of passing it through', () => {
    const event = toProviderOutputEvent({ id: 'n-5', timestamp: 1, type: 'system', content: 'a', metadata: { audience: 'loud' } });

    expect(event.metadata).toEqual({ audience: 'attention' });
  });

  it('does not stamp any other kind of message', () => {
    const types: OutputMessage['type'][] = ['assistant', 'user', 'tool_use', 'tool_result', 'error'];
    for (const type of types) {
      const event = toProviderOutputEvent({ id: `m-${type}`, timestamp: 1, type, content: 'x' });
      expect(event.metadata, type).toBeUndefined();
    }
    const withMetadata = toProviderOutputEvent({ id: 'm-r', timestamp: 1, type: 'tool_result', content: 'x', metadata: { exitCode: 1 } });
    expect(withMetadata.metadata).toEqual({ exitCode: 1 });
  });

  it('also stamps an event that never went through toProviderOutputEvent (an adapter string push, an older worker)', () => {
    // `pushOutput(content, 'system')` builds the event by hand, with no metadata at all.
    const bare: ProviderOutputEvent = { kind: 'output', content: 'Reconnecting…', messageType: 'system' };
    const withOther: ProviderOutputEvent = { kind: 'output', content: 'Reconnecting…', messageType: 'system', metadata: { diagnostic: true } };
    const routine: ProviderOutputEvent = { kind: 'output', content: 'Reconnecting…', messageType: 'system', metadata: { audience: 'routine' } };

    expect(toOutputMessageFromProviderOutputEvent(bare).metadata).toEqual({ audience: 'attention' });
    expect(toOutputMessageFromProviderOutputEvent(withOther).metadata).toEqual({ diagnostic: true, audience: 'attention' });
    expect(toOutputMessageFromProviderOutputEvent(routine).metadata).toEqual({ audience: 'routine' });
  });

  it('leaves a non-system event without metadata alone on the way back', () => {
    const assistant: ProviderOutputEvent = { kind: 'output', content: 'hello', messageType: 'assistant' };
    const untyped: ProviderOutputEvent = { kind: 'output', content: 'hello' };

    expect(toOutputMessageFromProviderOutputEvent(assistant).metadata).toBeUndefined();
    expect(toOutputMessageFromProviderOutputEvent(untyped).metadata).toBeUndefined();
  });

  it('survives the full trip as an explicit attention that still displays as attention', () => {
    const message: OutputMessage = { id: 'n-6', timestamp: 1, type: 'system', content: 'Interrupted — waiting for input' };

    const restored = toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(message));

    expect(restored.metadata).toEqual({ audience: 'attention' });
    expect(resolveSystemMessageAudience(restored)).toBe('attention');
  });

  it('is stable when applied twice', () => {
    const message: OutputMessage = { id: 'n-7', timestamp: 1, type: 'system', content: 'x' };

    const once = toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(message));
    const twice = toOutputMessageFromProviderOutputEvent(toProviderOutputEvent(once));

    expect(twice.metadata).toEqual(once.metadata);
  });
});
