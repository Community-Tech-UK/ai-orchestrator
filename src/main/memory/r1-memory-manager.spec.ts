import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { MemoryEntry, MemoryR1Snapshot } from '../../shared/types/memory-r1.types';
import { getEmbeddingService } from '../rlm/embedding-service';
import {
  getMemoryManager,
  MemoryManagerAgent,
} from './r1-memory-manager';

function createEntry(id: string, content: string): MemoryEntry {
  const now = Date.now();
  return {
    id,
    content,
    embedding: [0.1, 0.2, 0.3],
    createdAt: now,
    updatedAt: now,
    accessCount: 0,
    lastAccessedAt: now,
    sourceType: 'derived',
    sourceSessionId: 'session-1',
    relevanceScore: 0.5,
    confidenceScore: 0.8,
    linkedEntries: [],
    tags: ['test'],
    isArchived: false,
  };
}

describe('MemoryManagerAgent hardening', () => {
  let manager: MemoryManagerAgent;

  beforeEach(() => {
    MemoryManagerAgent._resetForTesting();
    manager = getMemoryManager();
    manager.configure({
      similarityThreshold: 0,
    });
  });

  afterEach(() => {
    MemoryManagerAgent._resetForTesting();
  });

  it('enforces maxEntries by evicting older low-priority entries', async () => {
    manager.configure({ maxEntries: 3, maxTokens: 100_000 });

    for (let i = 0; i < 5; i++) {
      await manager.addEntry(`entry-${i}-content`, 'test');
    }

    expect(manager.getAllEntries().length).toBeLessThanOrEqual(3);
    expect(manager.getStats().totalEntries).toBeLessThanOrEqual(3);
  });

  it('bounds retrieval history growth', async () => {
    manager.configure({ maxEntries: 100, maxTokens: 100_000 });
    await manager.addEntry('seed retrieval entry', 'seed');

    for (let i = 0; i < 10_050; i++) {
      await manager.retrieve(`query-${i}`, `task-${i}`);
    }

    const retrievalHistoryLength = (manager as unknown as {
      state: { retrievalHistory: unknown[] };
    }).state.retrievalHistory.length;

    expect(retrievalHistoryLength).toBeLessThanOrEqual(5000);
  });

  it('rejects updates that exceed max token budget', async () => {
    manager.configure({ maxEntries: 10, maxTokens: 40 });
    const entry = await manager.addEntry('small value', 'seed');

    await expect(
      manager.executeOperation({
        operation: 'UPDATE',
        entryId: entry.id,
        content: 'x'.repeat(500),
        confidence: 1,
        reasoning: 'force oversize update',
      })
    ).rejects.toThrow(/exceeds maxTokens/i);

    expect(manager.getEntry(entry.id)?.content).toBe('small value');
  });

  it('re-embeds a loaded entry that came from another model, so it can match again', async () => {
    const snapshot: MemoryR1Snapshot = {
      version: '1.0',
      timestamp: Date.now(),
      entries: [['old', createEntry('old', 'provider rate limit retries')]],
      operationHistory: [],
      retrievalHistory: [],
    };

    await manager.load(snapshot);

    const results = await manager.retrieve('provider rate limit retries', 'task');
    expect(results.map((entry) => entry.id)).toEqual(['old']);
    expect(results[0]?.embedding).toHaveLength(384);
    expect(results[0]?.embeddingModel).toBe('local-tfidf');
  });

  it('re-embeds loaded entries in small batches, so a search never waits behind them all', async () => {
    const embedBatch = vi.spyOn(getEmbeddingService(), 'embedBatch');
    const entries = Array.from({ length: 20 }, (_, index): [string, MemoryEntry] => (
      [`old-${index}`, createEntry(`old-${index}`, `retry policy number ${index}`)]
    ));

    await manager.load({
      version: '1.0',
      timestamp: Date.now(),
      entries,
      operationHistory: [],
      retrievalHistory: [],
    });

    expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([8, 8, 4]);
    expect(embedBatch).toHaveBeenCalledWith(expect.anything(), 'document');
    embedBatch.mockRestore();
  });

  it('never compares an entry from another model, even if its re-embedding failed', async () => {
    const text = 'provider rate limit retries';
    const { embedding } = await getEmbeddingService().embed(text, 'document');
    const embedBatch = vi.spyOn(getEmbeddingService(), 'embedBatch').mockRejectedValueOnce(new Error('model busy'));

    await expect(manager.load({
      version: '1.0',
      timestamp: Date.now(),
      entries: [['old', { ...createEntry('old', text), embedding, embeddingModel: 'another-model' }]],
      operationHistory: [],
      retrievalHistory: [],
    })).rejects.toThrow('model busy');
    embedBatch.mockRestore();

    await expect(manager.retrieve(text, 'task')).resolves.toEqual([]);
  });

  it('does not link a new entry to one from another model', async () => {
    const text = 'the worker queue retries failed jobs';
    const { embedding } = await getEmbeddingService().embed(text, 'document');
    const embedBatch = vi.spyOn(getEmbeddingService(), 'embedBatch').mockRejectedValueOnce(new Error('model busy'));
    await expect(manager.load({
      version: '1.0',
      timestamp: Date.now(),
      entries: [['old', { ...createEntry('old', text), embedding, embeddingModel: 'another-model' }]],
      operationHistory: [],
      retrievalHistory: [],
    })).rejects.toThrow('model busy');
    embedBatch.mockRestore();

    const added = await manager.addEntry(text, 'test');

    expect(added.linkedEntries).toEqual([]);
  });

  it('records which model produced each entry', async () => {
    const entry = await manager.addEntry('the worker queue retries failed jobs', 'test');

    expect(entry.embeddingModel).toBe('local-tfidf');
  });

  it('enforces capacity limits when loading snapshots', async () => {
    manager.configure({ maxEntries: 2, maxTokens: 100_000 });

    const entries: [string, MemoryEntry][] = [
      ['mem-1', createEntry('mem-1', 'one')],
      ['mem-2', createEntry('mem-2', 'two')],
      ['mem-3', createEntry('mem-3', 'three')],
      ['mem-4', createEntry('mem-4', 'four')],
    ];

    const snapshot: MemoryR1Snapshot = {
      version: '1.0',
      timestamp: Date.now(),
      entries,
      operationHistory: [],
      retrievalHistory: [],
    };

    await manager.load(snapshot);

    expect(manager.getAllEntries().length).toBeLessThanOrEqual(2);
    expect(manager.getStats().totalEntries).toBeLessThanOrEqual(2);
  });
});
