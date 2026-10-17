import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeJsonChunks } from '../../../../../shared/utils/json-chunks';
import { InstanceTranscriptReplayAssembler } from './instance-transcript-replay';
import type { Instance } from './instance.types';

const instance = { id: 'instance-placeholder', createdAt: 1, adapterGeneration: 1, restartEpoch: 0 } as Instance;
function packets(revision = 1, generation = 1) {
  const identity = { kind: 'history-replay', instanceId: instance.id, createdAt: 1,
    adapterGeneration: generation, restartEpoch: 0, revision };
  return encodeJsonChunks({ ...identity, messages: [{ id: 'recovered', type: 'assistant', timestamp: 1, content: 'restored '.repeat(100) }] }, `transfer-${revision}`, { chunkSize: 256 })
    .map(chunk => ({ ...identity, chunk }));
}
afterEach(() => vi.useRealTimers());
describe('replay incarnation and abandoned transfer handling', () => {
  it('expires abandoned assembly while live output continues and never commits its delayed suffix', () => {
    vi.useFakeTimers();
    const failure = vi.fn();
    const assembler = new InstanceTranscriptReplayAssembler(Date.now, failure);
    const transfer = packets();
    assembler.accept(transfer[0], instance);
    for (let i = 0; i < 35; i++) {
      vi.advanceTimersByTime(1000);
      assembler.noteLive(instance.id, { id: `live-${i}`, timestamp: i, type: 'assistant', content: 'live' });
    }
    for (const packet of transfer.slice(1)) expect(assembler.accept(packet, instance)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(failure).toHaveBeenCalledOnce();
    assembler.clear();
  });
  it('expires an abandoned transfer even when no further events arrive and clears timers on removal', () => {
    vi.useFakeTimers();
    const assembler = new InstanceTranscriptReplayAssembler();
    const transfer = packets();
    assembler.accept(transfer[0], instance);
    vi.advanceTimersByTime(30001);
    for (const packet of transfer.slice(1)) expect(assembler.accept(packet, instance)).toBeUndefined();
    assembler.accept(packets(2)[0], instance);
    assembler.clear(instance.id);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds the live journal and refuses to restart a failed transfer with missing live output', () => {
    const failure = vi.fn();
    const assembler = new InstanceTranscriptReplayAssembler(Date.now, failure);
    const transfer = packets();
    assembler.accept(transfer[0], instance);
    assembler.noteLive(instance.id, { id: 'large-live', timestamp: 2, type: 'assistant', content: 'a'.repeat(16 * 1024 * 1024) });
    for (const packet of transfer) expect(assembler.accept(packet, instance)).toBeUndefined();
    expect(failure).toHaveBeenCalledOnce();
    assembler.clear();
  });
  it('does not let an older revision supersede a newer incomplete transfer', () => {
    const assembler = new InstanceTranscriptReplayAssembler();
    assembler.accept(packets(2)[0], instance);
    for (const packet of packets(1)) expect(assembler.accept(packet, instance)).toBeUndefined();
    let result;
    for (const packet of packets(2).slice(1)) result = assembler.accept(packet, instance) ?? result;
    expect(result?.revision).toBe(2);
    assembler.clear();
  });
  it('drops replay from a replaced adapter before its batched lifecycle update arrives', () => {
    const assembler = new InstanceTranscriptReplayAssembler();
    const transfer = packets();
    assembler.accept(transfer[0], instance);
    assembler.noteLive(instance.id, { id: 'new-adapter', timestamp: 2, type: 'assistant', content: 'new', metadata: { adapterGeneration: 2 } });
    for (const packet of transfer.slice(1)) expect(assembler.accept(packet, instance)).toBeUndefined();
    assembler.clear();
  });
  it('rejects the old instance identity when an ID is recreated', () => {
    const assembler = new InstanceTranscriptReplayAssembler();
    for (const packet of packets()) expect(assembler.accept(packet, { ...instance, createdAt: 2 })).toBeUndefined();
    assembler.clear();
  });
});
