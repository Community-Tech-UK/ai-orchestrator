import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { observeLoopProviderRuntimeEvents } from './loop-provider-event-capture';

describe('observeLoopProviderRuntimeEvents', () => {
  it('publishes loop-owned adapter events through the canonical event stream with raw provenance', () => {
    const adapter = new EventEmitter();
    const emitProviderRuntimeEvent = vi.fn();
    const cleanup = observeLoopProviderRuntimeEvents({
      adapter: adapter as unknown as CliAdapter,
      instanceManager: { emitProviderRuntimeEvent },
      instanceId: 'loop-chat-1',
      provider: 'claude',
    });

    adapter.emit('status', 'busy');
    adapter.emit('output', {
      id: 'message-1',
      timestamp: 100,
      type: 'assistant',
      content: 'working',
    });

    expect(emitProviderRuntimeEvent).toHaveBeenNthCalledWith(
      1,
      'loop-chat-1',
      { kind: 'status', status: 'busy' },
      {
        provider: 'claude',
        timestamp: expect.any(Number),
        raw: { source: 'adapter-event:status', payload: 'busy' },
      },
    );
    expect(emitProviderRuntimeEvent).toHaveBeenNthCalledWith(
      2,
      'loop-chat-1',
      expect.objectContaining({ kind: 'output', content: 'working' }),
      {
        provider: 'claude',
        timestamp: 100,
        raw: {
          source: 'adapter-event:output',
          payload: expect.objectContaining({ content: 'working' }),
        },
      },
    );

    cleanup();
    adapter.emit('status', 'idle');
    expect(emitProviderRuntimeEvent).toHaveBeenCalledTimes(2);
  });
});
