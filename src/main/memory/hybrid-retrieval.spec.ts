import { beforeEach, describe, expect, it } from 'vitest';
import { HybridRetrievalManager } from './hybrid-retrieval';
import { MemoryManagerAgent } from './r1-memory-manager';

describe('HybridRetrievalManager', () => {
  beforeEach(() => {
    HybridRetrievalManager._resetForTesting();
    MemoryManagerAgent._resetForTesting();
  });

  it('lazily indexes entries added after construction', async () => {
    const memory = MemoryManagerAgent.getInstance();
    const hybrid = HybridRetrievalManager.getInstance();
    hybrid.configure({
      semanticWeight: 0,
      lexicalWeight: 1,
      enableDistillation: false,
      topK: 3,
    });

    await memory.addEntry('rarelexicaltoken appears in this memory entry', 'seed');

    const results = await hybrid.retrieve('rarelexicaltoken', 'task-1');

    expect(results[0]?.lexicalScore).toBeGreaterThan(0);
    expect(hybrid.getStats().indexedDocuments).toBe(1);
  });

  it('rebuilds the lexical index after entry deletion', async () => {
    const memory = MemoryManagerAgent.getInstance();
    const entry = await memory.addEntry('deletableuniquelexeme appears here', 'seed');
    const hybrid = HybridRetrievalManager.getInstance();
    hybrid.configure({
      semanticWeight: 0,
      lexicalWeight: 1,
      enableDistillation: false,
    });

    await hybrid.retrieve('deletableuniquelexeme', 'task-1');
    expect(hybrid.getStats().indexedDocuments).toBe(1);

    memory.deleteEntry(entry.id);
    await hybrid.retrieve('deletableuniquelexeme', 'task-2');

    expect(hybrid.getStats().indexedDocuments).toBe(0);
  });
});
