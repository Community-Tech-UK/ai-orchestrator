import { describe, expect, it } from 'vitest';
import { encodeJsonChunks, JsonChunkAssembler } from './json-chunks';

describe('bounded JSON transfer', () => {
  it('restores out-of-order chunks without truncating a large message or Unicode', () => {
    const value = { messages: [{ text: '😀'.repeat(80_000), attachment: 'large-image' }] };
    const chunks = encodeJsonChunks(value, 'recovery-one');
    expect(chunks.length).toBeGreaterThan(1);
    const assembler = new JsonChunkAssembler<typeof value>();
    const results = chunks.reverse().map(chunk => assembler.accept(chunk)).filter(Boolean);
    expect(results).toEqual([{ transferId: 'recovery-one', value }]);
  });

  it('commits once despite retries before and after completion', () => {
    const [first, last] = encodeJsonChunks({ text: 'hello' }, 'retry', { chunkSize: 8 });
    const assembler = new JsonChunkAssembler();
    expect(assembler.accept(first)).toBeUndefined();
    expect(assembler.accept(first)).toBeUndefined();
    expect(assembler.accept(last)).toEqual({ transferId: 'retry', value: { text: 'hello' } });
    expect(assembler.accept(first)).toBeUndefined();
    expect(assembler.accept(last)).toBeUndefined();
  });

  it('invalidates conflicting transfers without contaminating another instance', () => {
    const [first, last] = encodeJsonChunks({ text: 'hello' }, 'bad', { chunkSize: 8 });
    const assembler = new JsonChunkAssembler();
    assembler.accept(first);
    expect(() => assembler.accept({ ...first, text: 'different' })).toThrow();
    expect(assembler.accept(last)).toBeUndefined();
    expect(assembler.accept(encodeJsonChunks({ text: 'other' }, 'good')[0]))
      .toEqual({ transferId: 'good', value: { text: 'other' } });
  });

  it('bounds pending transfer count and total retained characters', () => {
    const assembler = new JsonChunkAssembler({ maxCharacters: 12, maxTransfers: 1 });
    assembler.accept({ transferId: 'one', index: 0, total: 2, text: '12345678' });
    expect(() => assembler.accept({ transferId: 'two', index: 0, total: 2, text: 'a' })).toThrow();
    expect(() => assembler.accept({ transferId: 'one', index: 1, total: 2, text: '12345' })).toThrow();
    expect(assembler.accept(encodeJsonChunks(null, 'three')[0]))
      .toEqual({ transferId: 'three', value: null });
  });

  it('expires partial transfers and releases their memory', () => {
    let now = 0;
    const assembler = new JsonChunkAssembler({ maxCharacters: 12, maxTransfers: 1, maxAgeMs: 30, now: () => now });
    assembler.accept({ transferId: 'expired', index: 0, total: 2, text: '12345678' });
    now = 31;
    expect(assembler.accept(encodeJsonChunks({ ok: true }, 'fresh')[0]))
      .toEqual({ transferId: 'fresh', value: { ok: true } });
  });

  it('clears pending and completed identities at consumer teardown', () => {
    const assembler = new JsonChunkAssembler({ maxTransfers: 1 });
    assembler.accept({ transferId: 'pending', index: 0, total: 2, text: '{}' });
    assembler.clear('pending');
    expect(assembler.accept(encodeJsonChunks(1, 'complete')[0])?.value).toBe(1);
    assembler.clear();
    expect(assembler.accept(encodeJsonChunks(2, 'complete')[0])?.value).toBe(2);
  });

  it.each([
    null,
    { transferId: '', index: 0, total: 1, text: '{}' },
    { transferId: 'bad', index: -1, total: 1, text: '{}' },
    { transferId: 'bad', index: 1, total: 1, text: '{}' },
    { transferId: 'bad', index: 0.5, total: 2, text: '{}' },
    { transferId: 'bad', index: 0, total: 100_000_000, text: '{}' },
    { transferId: 'bad', index: 0, total: 1, text: 42 },
    { transferId: 'bad', index: 0, total: 1, text: 'x'.repeat(65_537) },
  ])('rejects malformed transport input', chunk => {
    expect(() => new JsonChunkAssembler().accept(chunk)).toThrow();
  });

  it('rejects inconsistent chunk counts and malformed JSON', () => {
    const assembler = new JsonChunkAssembler();
    assembler.accept({ transferId: 'count', index: 0, total: 2, text: '{' });
    expect(() => assembler.accept({ transferId: 'count', index: 1, total: 3, text: '}' })).toThrow();
    expect(() => assembler.accept({ transferId: 'json', index: 0, total: 1, text: '{' })).toThrow();
    expect(assembler.accept(encodeJsonChunks(true, 'healthy')[0])?.value).toBe(true);
  });

  it('fails explicitly for unserializable or oversized output', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => encodeJsonChunks(cyclic, 'cycle')).toThrow();
    expect(() => encodeJsonChunks(undefined, 'undefined')).toThrow();
    expect(() => encodeJsonChunks('oversized', 'size', { maxCharacters: 4 })).toThrow();
    expect(() => encodeJsonChunks('okay', 'zero', { chunkSize: 0 })).toThrow();
  });
});
