import { describe, expect, it } from 'vitest';
import { selectCompactionTail } from './compaction-tail';

describe('compaction tail', () => {
  it('keeps whole exchanges and the latest user request without clipping it', () => {
    const turns = [
      { role: 'user' as const, content: 'old'.repeat(3000) },
      { role: 'assistant' as const, content: 'old reply'.repeat(3000) },
      { role: 'user' as const, content: 'latest'.repeat(3000) },
      { role: 'assistant' as const, content: 'reply' },
    ];
    const selected = selectCompactionTail(turns, 8000);
    expect(selected.keptIndices).toEqual([2, 3]);
    expect(selected.affectedIndices).toEqual([0, 1]);
  });
  it('keeps a small conversation entirely and bounds explicit keep counts by tokens', () => {
    expect(selectCompactionTail([{ role: 'user', content: 'hello' }], 100000).affectedIndices).toEqual([]);
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(5000) }));
    expect(selectCompactionTail(turns, 10000, 10).keptIndices.length).toBeLessThan(20);
    expect(selectCompactionTail(turns, 10000, 10).keptIndices).toContain(18);
  });
});
