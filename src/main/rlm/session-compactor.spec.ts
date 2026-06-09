import { describe, expect, it, vi } from 'vitest';
import { SessionCompactor } from './session-compactor';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('SessionCompactor archived turn reads', () => {
  it('loads archived turns through an explicit cap before compacting a session', () => {
    const allCalls: unknown[][] = [];
    const archivedRows = Array.from({ length: 1_200 }, (_, index) => ({
      id: `arch-${index}`,
      session_id: 'session-1',
      turn_index: index,
      query_json: JSON.stringify({
        query: { type: 'semantic', params: { q: String(index) } },
        result: `result ${index}`,
        tokensUsed: 1,
        sectionsAccessed: [],
        duration: 1,
        depth: 0,
      }),
      archived_at: 100 + index,
      summary_id: null,
    }));
    const rawDb = {
      exec: vi.fn(),
      prepare: vi.fn((sql: string) => ({
        run: vi.fn(),
        all: vi.fn((...params: unknown[]) => {
          allCalls.push(params);
          const limit = typeof params.at(-1) === 'number' && sql.includes('LIMIT')
            ? params.at(-1) as number
            : archivedRows.length;
          return archivedRows.slice(0, limit);
        }),
      })),
    };
    const compactor = new SessionCompactor({ maxArchivedTurns: 500 });
    (compactor as unknown as { db: { db: typeof rawDb } }).db = { db: rawDb };

    const archived = compactor.getArchivedTurns('session-1');

    expect(archived).toHaveLength(500);
    expect(rawDb.prepare).toHaveBeenCalledWith(expect.stringContaining('LIMIT ?'));
    expect(allCalls).toEqual([['session-1', 500]]);
  });
});
