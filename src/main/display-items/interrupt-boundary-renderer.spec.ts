import { describe, expect, it, vi } from 'vitest';
import { buildInterruptBoundaryMessage, emitInterruptBoundaryDisplayMarker } from './interrupt-boundary-renderer';
import type { Instance } from '../../shared/types/instance.types';

describe('interrupt boundary output', () => {
  it('stores a plain sentence while preserving the machine-readable boundary', () => {
    expect(buildInterruptBoundaryMessage({ phase: 'completed', outcome: 'respawn-success', requestId: 'request', at: 10 }))
      .toMatchObject({ type: 'system', timestamp: 10, content: 'Stopped. The session restarted and kept its history.',
        metadata: { kind: 'interrupt-boundary', phase: 'completed', outcome: 'respawn-success', requestId: 'request' } });
  });
  it('publishes the same sentence to the buffer and live stream', () => {
    const instance = { id: 'instance' } as Instance;
    const addToOutputBuffer = vi.fn();
    const emitOutput = vi.fn();
    emitInterruptBoundaryDisplayMarker(instance, { phase: 'completed', outcome: 'cancelled', requestId: 'request' }, { addToOutputBuffer, emitOutput });
    expect(addToOutputBuffer).toHaveBeenCalledWith(instance, expect.objectContaining({ content: 'The agent stopped.' }));
    expect(emitOutput).toHaveBeenCalledWith('instance', addToOutputBuffer.mock.calls[0][1]);
  });
});
