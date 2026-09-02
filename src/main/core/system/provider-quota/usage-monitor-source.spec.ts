import { describe, it, expect } from 'vitest';
import { UsageMonitorSource } from './usage-monitor-source';
import { evaluateQuotaThrottle } from '../../../orchestration/loop-quota-throttle';
import { ProviderQuotaWindowSchema } from '@contracts/schemas/quota';

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

  it('treats a 10-min-old file as fresh under the production default ceiling', async () => {
    // The standalone monitor's launchd poller fires every 600s, so state.json is
    // routinely up to ~10 min old. The production default ceiling must tolerate a
    // full poll cycle — otherwise the Antigravity/Cursor fallback silently dies
    // for half of every cycle. No maxAgeMs override here: exercise the real default.
    const src = new UsageMonitorSource({
      statePath: '/fake/state.json',
      now: () => NOW,
      statFile: async () => ({ mtimeMs: NOW - 10 * 60_000 }), // 10 min old
      readFile: async () => JSON.stringify({ cursor: { windows: [{ label: 'included', used_percent: 65 }] } }),
    });
    const cursor = await src.readProvider('cursor');
    expect(cursor).not.toBeNull();
    expect(cursor!.windows[0].used).toBe(65);
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

  it('aliases the legacy gemini state key onto the antigravity provider', async () => {
    const src = makeSource({
      json: {
        providers: {
          gemini: {
            plan: 'personal',
            windows: [
              { label: 'pro · daily', used_percent: 11.5, reset_at: '2026-06-19T00:00:00Z' },
              { label: 'flash · daily', used_percent: 0 },
            ],
          },
        },
      },
    });
    const ag = await src.readProvider('antigravity');
    expect(ag).not.toBeNull();
    expect(ag!.provider).toBe('antigravity');
    expect(ag!.plan).toBe('personal');
    expect(ag!.windows[0].id).toBe('antigravity.pro-daily');
    expect(ag!.windows[0].used).toBeCloseTo(11.5);
  });

  it('prefers a native antigravity entry over the gemini alias', async () => {
    const src = makeSource({
      json: {
        providers: {
          gemini: { windows: [{ label: 'pro · daily', used_percent: 11.5 }] },
          antigravity: { plan: 'pro', windows: [{ label: 'agy', used_percent: 80 }] },
        },
      },
    });
    const ag = await src.readProvider('antigravity');
    expect(ag!.plan).toBe('pro');
    expect(ag!.windows).toHaveLength(1);
    expect(ag!.windows[0].id).toBe('antigravity.agy');
    expect(ag!.windows[0].used).toBe(80);
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

// Regression: this fallback source is what CompositeQuotaProbe uses whenever a
// native probe is degraded, so it reproduced the phantom-overage park even
// after the native Cursor/Grok probes were fixed. The monitor writes ratio
// windows labelled `usd` (see the Cursor fixture above), which the loop
// throttle read as a paid-overage bucket.
describe('UsageMonitorSource overage classification', () => {
  it('re-labels ratio-shaped windows as percent and not overage', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            windows: [
              { id: 'cursor.included', label: 'Cursor included', unit: 'usd', used_percent: 42 },
            ],
          },
        },
      },
    });

    const window = (await src.readProvider('cursor'))!.windows[0];
    expect(window.unit).toBe('percent');
    expect(window.overage).toBeUndefined();
  });

  it('still flags the on-demand bucket as real spend', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            windows: [
              { id: 'cursor.on-demand', label: 'On-demand', unit: 'usd', used_percent: 8 },
            ],
          },
        },
      },
    });

    expect((await src.readProvider('cursor'))!.windows[0].overage).toBe(true);
  });

  it('honours an explicit overage flag and leaves true dollar windows alone', async () => {
    const src = makeSource({
      json: {
        providers: {
          claude: {
            windows: [
              { id: 'claude.credits', label: 'Credits', unit: 'usd', used: 5, limit: 100 },
              { id: 'claude.5h', label: '5h', unit: 'messages', used: 10, limit: 100, overage: false },
            ],
          },
        },
      },
    });

    const byId = Object.fromEntries((await src.readProvider('claude'))!.windows.map((w) => [w.id, w]));
    // Numeric used/limit means a genuine dollar window: unit preserved, and the
    // throttle's `unit === 'usd'` fallback still classifies it as overage.
    expect(byId['claude.credits'].unit).toBe('usd');
    expect(byId['claude.credits'].overage).toBeUndefined();
    expect(byId['claude.5h'].overage).toBe(false);
  });
});

/**
 * The seam the native-probe fix alone did not close: CompositeQuotaProbe falls
 * back to this source whenever the native probe is degraded, so a Cursor loop
 * could still park at 0 iterations on a phantom overage via this path.
 */
describe('UsageMonitorSource output through the loop throttle', () => {
  it('lets a Cursor loop run on monitor-sourced plan usage', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            windows: [
              { id: 'cursor.included', label: 'Cursor included', unit: 'usd', used_percent: 42, reset_at: '2026-07-01T00:00:00Z' },
            ],
          },
        },
      },
    });

    expect(evaluateQuotaThrottle(await src.readProvider('cursor')).action).toBe('continue');
  });

  it('still guards monitor-sourced on-demand spend', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            windows: [
              { id: 'cursor.on-demand', label: 'On-demand', unit: 'usd', used_percent: 8, reset_at: '2026-07-01T00:00:00Z' },
            ],
          },
        },
      },
    });

    expect(evaluateQuotaThrottle(await src.readProvider('cursor')).action).toBe('overage-guard');
  });

  it('emits windows the strict renderer-event schema accepts', async () => {
    const src = makeSource({
      json: {
        providers: {
          cursor: {
            windows: [
              { id: 'cursor.included', label: 'Included', unit: 'usd', used_percent: 42, reset_at: '2026-07-01T00:00:00Z' },
              { id: 'cursor.on-demand', label: 'On-demand', unit: 'usd', used_percent: 8, reset_at: '2026-07-01T00:00:00Z' },
            ],
          },
          claude: { windows: [{ id: 'claude.5h', label: '5h', unit: 'messages', used: 10, limit: 100 }] },
        },
      },
    });

    for (const provider of ['cursor', 'claude'] as const) {
      for (const window of (await src.readProvider(provider))!.windows) {
        const parsed = ProviderQuotaWindowSchema.safeParse(window);
        expect(parsed.success, `${window.id}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
      }
    }
  });
});
