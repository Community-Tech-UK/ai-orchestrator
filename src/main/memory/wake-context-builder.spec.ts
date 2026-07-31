/**
 * Wake-context volatility regression (WS-B4).
 *
 * `WakeContext.identity.generatedAt` / `essentialStory.generatedAt` are
 * `Date.now()` snapshots on the returned objects, but `getWakeUpText()` — the
 * only method instance-lifecycle.ts calls to build the wake-context block of
 * the system prompt — joins only `identity.content` and
 * `essentialStory.content`. Neither content string embeds `generatedAt`, so
 * the rendered text is time-independent even though the metadata is not.
 * This locks that: two renders under different mocked clocks must be
 * byte-identical.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WakeHintRow } from '../persistence/rlm-database.types';

const hintRows: WakeHintRow[] = [];

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getRawDb: () => ({
      prepare: (sql: string) => ({
        all: () => (sql.includes('SELECT * FROM wake_hints') ? hintRows : []),
        get: () => undefined,
        run: () => ({ changes: 0 }),
      }),
    }),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { WakeContextBuilder, getWakeContextBuilder } from './wake-context-builder';

describe('WakeContextBuilder rendered text time-independence', () => {
  beforeEach(() => {
    WakeContextBuilder._resetForTesting();
    hintRows.length = 0;
  });

  afterEach(() => {
    WakeContextBuilder._resetForTesting();
    vi.useRealTimers();
  });

  it('renders identical text with no hints under different mocked clocks', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = getWakeContextBuilder().getWakeUpText(undefined, { bypassCache: true });

    vi.setSystemTime(new Date('2031-06-15T12:34:56.000Z'));
    const second = getWakeContextBuilder().getWakeUpText(undefined, { bypassCache: true });

    expect(second).toBe(first);
  });

  it('renders identical text with hints present under different mocked clocks', () => {
    hintRows.push(
      {
        id: 'hint_1',
        content: 'Prefer const over let when the binding is never reassigned.',
        importance: 9,
        room: 'general',
        source_reflection_id: null,
        source_session_id: null,
        created_at: 1_700_000_000_000,
        last_used: 1_700_000_000_000,
        usage_count: 0,
      },
      {
        id: 'hint_2',
        content: 'The renderer is zoneless; do not import zone.js.',
        importance: 7,
        room: 'renderer',
        source_reflection_id: null,
        source_session_id: null,
        created_at: 1_700_000_001_000,
        last_used: 1_700_000_001_000,
        usage_count: 0,
      },
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const first = getWakeContextBuilder().getWakeUpText(undefined, { bypassCache: true });

    vi.setSystemTime(new Date('2031-06-15T12:34:56.000Z'));
    const second = getWakeContextBuilder().getWakeUpText(undefined, { bypassCache: true });

    expect(second).toBe(first);
    // Sanity: the hint content actually made it into the rendered text, so
    // this isn't trivially passing on the empty-hints fixed string.
    expect(first).toContain('Prefer const over let');
  });

  it('never renders a raw generatedAt millisecond timestamp into the wake-up text', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const text = getWakeContextBuilder().getWakeUpText(undefined, { bypassCache: true });
    const nowMs = Date.now();

    expect(text).not.toContain(String(nowMs));
  });
});
