import { describe, it, expect, vi } from 'vitest';
import { bufferToEmbedding, pruneVectorsOlderThan } from './rlm-vectors';
import type { SqliteDriver } from '../../db/sqlite-driver';

describe('bufferToEmbedding', () => {
  function makeBlob(values: number[]): Buffer {
    return Buffer.from(new Float32Array(values).buffer);
  }

  it('returns a Float32Array, not boxed doubles', () => {
    const result = bufferToEmbedding(makeBlob([0.5, -0.25, 1]));

    // The whole point: `number[]` costs 8 bytes per element instead of 4.
    expect(result).toBeInstanceOf(Float32Array);
    expect(Array.from(result)).toEqual([0.5, -0.25, 1]);
  });

  it('copies rather than viewing the source buffer', () => {
    // Node allocates small Buffers out of a shared ~8 KB pool. A Float32Array
    // *view* over that pool would pin the entire slab for the life of the
    // cached vector — leaking far more than the doubles fix saves.
    const blob = makeBlob([1, 2, 3]);
    const result = bufferToEmbedding(blob);

    expect(result.buffer).not.toBe(blob.buffer);
    expect(result.byteLength).toBe(12);

    // Mutating the source must not disturb the returned embedding.
    blob.writeFloatLE(99, 0);
    expect(result[0]).toBe(1);
  });

  it('round-trips the dimensions of a realistic embedding', () => {
    const dims = Array.from({ length: 384 }, (_, i) => i / 384);
    const result = bufferToEmbedding(makeBlob(dims));

    expect(result.length).toBe(384);
    expect(result.byteLength).toBe(1536);
  });
});

describe('pruneVectorsOlderThan', () => {
  function makeDb(summary: { matched: number; stores: number; embedding_bytes: number }) {
    const run = vi.fn();
    const get = vi.fn(() => summary);
    const prepare = vi.fn((sql: string) => ({ get, run, all: vi.fn(() => []), sql }));
    return { db: { prepare } as unknown as SqliteDriver, prepare, run };
  }

  it('reports without deleting by default', () => {
    const { db, run } = makeDb({ matched: 1200, stores: 40, embedding_bytes: 1_843_200 });

    const report = pruneVectorsOlderThan(db, 1_000);

    expect(report.matched).toBe(1200);
    expect(report.deleted).toBe(0);
    expect(report.applied).toBe(false);
    expect(report.stores).toBe(40);
    expect(report.embeddingBytes).toBe(1_843_200);
    // Deleting months of accumulated memory must never be the default.
    expect(run).not.toHaveBeenCalled();
  });

  it('deletes only when apply is explicitly true', () => {
    const { db, prepare, run } = makeDb({ matched: 7, stores: 2, embedding_bytes: 10_752 });

    const report = pruneVectorsOlderThan(db, 5_000, { apply: true });

    expect(report.deleted).toBe(7);
    expect(report.applied).toBe(true);
    expect(run).toHaveBeenCalledWith(5_000);
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM vectors'))).toBe(true);
  });

  it('skips the delete entirely when nothing matches', () => {
    const { db, run } = makeDb({ matched: 0, stores: 0, embedding_bytes: 0 });

    const report = pruneVectorsOlderThan(db, 5_000, { apply: true });

    expect(report.deleted).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });
});
