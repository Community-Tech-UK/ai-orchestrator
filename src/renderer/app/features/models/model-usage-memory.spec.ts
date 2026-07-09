import { describe, expect, it } from 'vitest';
import {
  MODEL_USAGE_MAX_ENTRIES,
  compareModelUsageKeys,
  modelUsageKey,
  modelUsageScore,
  orderFavoriteRowsByUsage,
  orderProviderRowsByUsage,
  recordModelUsage,
} from './model-usage-memory';

describe('model-usage-memory', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 6, 9, 12, 0, 0);

  it('builds provider:model keys', () => {
    expect(modelUsageKey('claude', 'claude-fable-5')).toBe('claude:claude-fable-5');
  });

  it('scores count plus decaying recency boost', () => {
    expect(modelUsageScore({ count: 3, lastUsedAt: now }, now)).toBe(13);
    expect(modelUsageScore({ count: 3, lastUsedAt: now - 5 * day }, now)).toBe(8);
    expect(modelUsageScore({ count: 3, lastUsedAt: now - 15 * day }, now)).toBe(3);
    expect(modelUsageScore(undefined, now)).toBe(0);
  });

  it('ranks recent frequent models above stale ones', () => {
    const usage = {
      'claude:claude-fable-5': { count: 4, lastUsedAt: now },
      'claude:claude-opus-4-8': { count: 10, lastUsedAt: now - 20 * day },
      'claude:claude-sonnet-4-6': { count: 1, lastUsedAt: now - day },
    };
    const catalogIndex = (key: string) => {
      const order = [
        'claude:claude-opus-4-8',
        'claude:claude-fable-5',
        'claude:claude-sonnet-4-6',
      ];
      return order.indexOf(key);
    };

    const keys = Object.keys(usage).sort((a, b) =>
      compareModelUsageKeys(a, b, usage, catalogIndex, now),
    );

    // fable: 4 + 10 = 14; sonnet: 1 + 9 = 10; opus: 10 + 0 = 10 (sonnet wins tie on lastUsedAt)
    expect(keys).toEqual([
      'claude:claude-fable-5',
      'claude:claude-sonnet-4-6',
      'claude:claude-opus-4-8',
    ]);
  });

  it('increments count and refreshes lastUsedAt', () => {
    const next = recordModelUsage(
      { 'claude:claude-fable-5': { count: 2, lastUsedAt: now - day } },
      'claude:claude-fable-5',
      now,
    );
    expect(next['claude:claude-fable-5']).toEqual({ count: 3, lastUsedAt: now });
  });

  it('trims lowest-scoring entries when over the cap', () => {
    let usage: Record<string, { count: number; lastUsedAt: number }> = {};
    for (let i = 0; i < MODEL_USAGE_MAX_ENTRIES + 5; i++) {
      usage = recordModelUsage(
        usage,
        `claude:model-${i}`,
        now - (MODEL_USAGE_MAX_ENTRIES + 5 - i) * day,
      );
    }

    expect(Object.keys(usage)).toHaveLength(MODEL_USAGE_MAX_ENTRIES);
    expect(usage['claude:model-0']).toBeUndefined();
    expect(usage[`claude:model-${MODEL_USAGE_MAX_ENTRIES + 4}`]).toBeDefined();
  });

  it('orders provider rows with used models first', () => {
    const rows = [
      { key: 'claude:opus-latest', name: 'Opus latest' },
      { key: 'claude:claude-fable-5', name: 'Fable 5' },
      { key: 'claude:claude-opus-4-8', name: 'Opus 4.8' },
    ];
    const usage = {
      'claude:claude-fable-5': { count: 5, lastUsedAt: now },
      'claude:claude-opus-4-8': { count: 2, lastUsedAt: now - day },
    };

    expect(orderProviderRowsByUsage(rows, usage, now).map((row) => row.name)).toEqual([
      'Fable 5',
      'Opus 4.8',
      'Opus latest',
    ]);
  });

  it('keeps starred favorites first, then used non-favorites', () => {
    const rows = [
      { key: 'claude:opus-latest', name: 'Opus latest' },
      { key: 'claude:claude-fable-5', name: 'Fable 5' },
      { key: 'codex:gpt-5.5', name: 'GPT-5.5' },
    ];
    const usage = {
      'claude:claude-fable-5': { count: 3, lastUsedAt: now },
    };

    expect(
      orderFavoriteRowsByUsage(rows, ['codex:gpt-5.5', 'claude:opus-latest'], usage, now)
        .map((row) => row.name),
    ).toEqual(['GPT-5.5', 'Opus latest', 'Fable 5']);
  });
});
