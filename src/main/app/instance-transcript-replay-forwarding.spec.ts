import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { createInstance } from '../../shared/types/instance.types';
import { JsonChunkAssembler } from '../../shared/utils/json-chunks';
import { setupInstanceTranscriptReplayForwarding } from './instance-transcript-replay-forwarding';

function setup() {
  const instance = Object.assign(createInstance({ workingDirectory: '/tmp/placeholder', provider: 'opencode' }), {
    id: 'instance-placeholder', adapterGeneration: 2, restartEpoch: 1,
  });
  const manager = Object.assign(new EventEmitter(), { getInstance: () => instance });
  const order: string[] = [];
  const enqueue = vi.fn(() => { order.push('persist'); return { accepted: true as const }; });
  const sendToRenderer = vi.fn((_channel: string, _payload: unknown) => { order.push('send'); });
  const cleanup = setupInstanceTranscriptReplayForwarding({ instanceManager: manager,
    windowManager: { sendToRenderer }, continuityQueue: { enqueue } });
  return { instance, manager, cleanup, enqueue, sendToRenderer, order };
}

describe('native history replay forwarding', () => {
  it('preserves a large individual attachment through the real chunk encoder and queues repaired continuity first', () => {
    const fixture = setup();
    try {
      const messages = [{ id: 'native-message', type: 'user', timestamp: 1, content: 'placeholder',
        attachments: [{ name: 'placeholder.txt', type: 'text/plain', size: 140000, data: 'a'.repeat(140000) }] }];
      fixture.manager.emit('history-replayed', { instanceId: fixture.instance.id, adapterGeneration: 2, restartEpoch: 1, messages });
      expect(fixture.order[0]).toBe('persist');
      expect(fixture.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'state', update: expect.objectContaining({
        conversationHistoryComplete: false, conversationHistoryOriginKnown: false,
        conversationHistory: [expect.objectContaining({ id: 'native-message', role: 'user', content: 'placeholder' })],
      }) }));
      const assembler = new JsonChunkAssembler<{ messages: unknown[] }>();
      let completed: { messages: unknown[] } | undefined;
      for (const [channel, packet] of fixture.sendToRenderer.mock.calls) {
        expect(channel).toBe(IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK);
        const result = assembler.accept((packet as { chunk: unknown }).chunk);
        if (result) completed = result.value;
      }
      expect(completed?.messages).toEqual(messages);
    } finally { fixture.cleanup(); }
  });
  it('rejects replaced adapters and removes its listeners during cleanup', () => {
    const fixture = setup();
    fixture.manager.emit('history-replayed', { instanceId: fixture.instance.id, adapterGeneration: 1, restartEpoch: 1, messages: [] });
    expect(fixture.sendToRenderer).not.toHaveBeenCalled();
    expect(fixture.enqueue).not.toHaveBeenCalled();
    fixture.cleanup();
    expect(fixture.manager.listenerCount('history-replayed')).toBe(0);
    expect(fixture.manager.listenerCount('instance:removed')).toBe(0);
  });
  it('signals a transfer failure explicitly instead of truncating invalid history', () => {
    const fixture = setup();
    try {
      fixture.manager.emit('history-replayed', { instanceId: fixture.instance.id, adapterGeneration: 2, restartEpoch: 1,
        messages: [{ id: 'invalid-placeholder', type: 'assistant', timestamp: 1, content: 42 }] });
      expect(fixture.sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK,
        expect.objectContaining({ kind: 'history-replay-error', instanceId: fixture.instance.id }));
      expect(fixture.enqueue).not.toHaveBeenCalled();
    } finally { fixture.cleanup(); }
  });
});
