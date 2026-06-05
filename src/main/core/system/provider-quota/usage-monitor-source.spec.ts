import { describe, it, expect } from 'vitest';
import { UsageMonitorSource } from './usage-monitor-source';

const NOW = 1_750_000_000_000;

function makeSource(opts: {
  json?: unknown;
  mtimeMs?: number;
  readThrows?: boolean;
  statThrows?: boolean;
  maxAgeMs?: number;
}): UsageMonitorSource {
  return new UsageMonitorSource({
    statePath: '/fake/state.json',
    maxAgeMs: opts.maxAgeMs ?? 5 * 60_000,
    now: () => NOW,
    statFile: async () => {
      if (opts.statThrows) throw new Error('no stat');
      return { mtimeMs: opts.mtimeMs ?? NOW };
    },
    readFile: async () => {
      if (opts.readThrows) throw new Error('no read');
      return JSON.stringify(opts.json ?? {});
    },
  });
}

describe('UsageMonitorSource', () => {
  it('reads windows from a providers map', async () => {
    const src = makeSource({
      json: {
        updated_at: NOW / 1000,
        providers: {
          codex: {
            plan: 'plus',
            windows: [
              { id: 'codex.weekly', label: 'Weekly', unit: 'requests', used: 12, limit: 100, resets_at: '2026-06-12T00:00:00Z' },
            ],
          },
        },
      },
    });
    const all = await src.read();
    expect(all).not.toBeNull();
    const codex = all!.get('codex');
    expect(codex!.ok).toBe(true);
    expect(codex!.plan).toBe('plus');
    expect(codex!.windows[0].used).toBe(12);
    expect(codex!.windows[0].remaining).toBe(88);
    expect(codex!.windows[0].resetsAt).toBe(Date.parse('2026-06-12T00:00:00Z'));
  });

  it('accepts provider keys at the root (no providers wrapper)', async () => {
    const src = makeSource({
      json: {
        claude: { windows: [{ label: '5h', used: 40, limit: 100 }] },
      },
    });
    const claude = await src.readProvider('claude');
    expect(claude!.windows[0].id).toBe('claude.5h');
    expect(claude!.windows[0].label).toBe('5h');
  });

  it('preserves Cursor windows written by token-usage-monitor', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            plan: 'pro',
            windows: [
              { id: 'cursor.included', label: 'Cursor included', unit: 'usd', used_percent: 42, reset_at: '2026-07-01T00:00:00Z' },
            ],
          },
        },
      },
    });
    const cursor = await src.readProvider('cursor');
    expect(cursor).not.toBeNull();
    expect(cursor!.provider).toBe('cursor');
    expect(cursor!.plan).toBe('pro');
    expect(cursor!.windows[0].id).toBe('cursor.included');
    expect(cursor!.windows[0].used).toBe(42);
    expect(cursor!.windows[0].limit).toBe(100);
    expect(cursor!.windows[0].remaining).toBe(58);
    expect(cursor!.windows[0].resetsAt).toBe(Date.parse('2026-07-01T00:00:00Z'));
  });

  it('treats epoch-seconds resets as ms', async () => {
    const src = makeSource({
      json: { claude: { windows: [{ label: 'w', used: 1, limit: 2, resets_at: 1_750_500_000 }] } },
    });
    const snap = await src.readProvider('claude');
    expect(snap!.windows[0].resetsAt).toBe(1_750_500_000 * 1000);
  });

  it('returns null when the file is stale', async () => {
    const src = makeSource({
      mtimeMs: NOW - 10 * 60_000, // 10 min old, > 5 min ceiling
      json: { claude: { windows: [{ label: 'w', used: 1, limit: 2 }] } },
    });
    expect(await src.read()).toBeNull();
  });

  it('returns null when the file is absent (stat throws)', async () => {
    const src = makeSource({ statThrows: true });
    expect(await src.read()).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const src = new UsageMonitorSource({
      statePath: '/fake/state.json',
      now: () => NOW,
      statFile: async () => ({ mtimeMs: NOW }),
      readFile: async () => 'not json',
    });
    expect(await src.read()).toBeNull();
  });

  it('skips windows missing numeric used/limit', async () => {
    const src = makeSource({
      json: { gemini: { windows: [{ label: 'bad' }, { label: 'ok', used: 5, limit: 10 }] } },
    });
    const snap = await src.readProvider('gemini');
    expect(snap!.windows).toHaveLength(1);
    expect(snap!.windows[0].label).toBe('ok');
  });
});
