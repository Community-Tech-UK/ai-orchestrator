import { describe, expect, it, vi } from 'vitest';
import { ProviderOutputRendererGate } from './provider-output-renderer-gate';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

function makeEnvelope(
  partial: Partial<ProviderRuntimeEventEnvelope> = {},
): ProviderRuntimeEventEnvelope {
  return {
    eventId: 'evt-1',
    seq: 0,
    timestamp: 1_717_000_000_000,
    provider: 'codex',
    instanceId: 'inst-1',
    event: {
      kind: 'output',
      content: 'hello',
      messageType: 'assistant',
      messageId: 'msg-1',
      timestamp: 1_717_000_000_000,
    },
    ...partial,
  };
}

describe('ProviderOutputRendererGate', () => {
  it('suppresses the matching legacy instance output after a provider output envelope', () => {
    const gate = new ProviderOutputRendererGate();

    gate.noteEnvelope(makeEnvelope());

    expect(gate.shouldForward({
      instanceId: 'inst-1',
      message: { id: 'msg-1' },
    })).toBe(false);
    expect(gate.shouldForward({
      instanceId: 'inst-1',
      message: { id: 'msg-1' },
    })).toBe(true);
  });

  it('ignores provider events without a stable message id', () => {
    const gate = new ProviderOutputRendererGate();

    gate.noteEnvelope(makeEnvelope({
      event: {
        kind: 'output',
        content: 'hello',
      },
    }));

    expect(gate.shouldForward({
      instanceId: 'inst-1',
      message: { id: 'msg-1' },
    })).toBe(true);
  });

  it('expires stale suppression entries', () => {
    vi.useFakeTimers();
    const gate = new ProviderOutputRendererGate(100);

    gate.noteEnvelope(makeEnvelope());
    vi.advanceTimersByTime(101);

    expect(gate.shouldForward({
      instanceId: 'inst-1',
      message: { id: 'msg-1' },
    })).toBe(true);

    vi.useRealTimers();
  });
});
