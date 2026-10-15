import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from './loop-schema';
import { LoopStore } from './loop-store';
import { registerLoopOutstandingLive } from './loop-outstanding-live';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
it('captures each round, sends one event/notice, and guards risks without duplicate hints', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-outstanding-'));
  const db = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(db);
  const store = new LoopStore(db);
  const paths = resolveLoopArtifactPaths(dir, 'run'); mkdirSync(paths.dir, { recursive: true });
  let hook: (input: { state: LoopState; iteration: LoopIteration }) => Promise<void> = async () => undefined;
  const intervene = vi.fn(); const send = vi.fn(); const notify = vi.fn();
  const state = { id: 'run', chatId: 'chat', config: defaultLoopConfig(dir, 'Implement export'), status: 'running', totalIterations: 1 } as LoopState;
  try {
    registerLoopOutstandingLive({ coordinator: { registerIterationHook: fn => { hook = fn; }, intervene }, store, send, notify });
    writeFileSync(paths.outstanding, '## Decisions applied\n- Buy the paid tier\n  - Applied: Pro.');
    await hook({ state, iteration: { seq: 1 } as LoopIteration });
    await hook({ state, iteration: { seq: 2 } as LoopIteration });
    expect(store.listOutstandingItems()[0]).toMatchObject({ riskClass: 'money', firstSeenRound: 1 });
    expect(send).toHaveBeenCalledOnce(); expect(notify).toHaveBeenCalledOnce();
    expect(intervene).toHaveBeenCalledOnce();
    expect(intervene.mock.calls[0]).toEqual(['run', expect.stringContaining('spending money'), 'queue', undefined, 'loop-question']);
    writeFileSync(paths.outstanding, '## Decisions applied\n- Buy the paid tier\n  - Applied: Enterprise.');
    await hook({ state, iteration: { seq: 3 } as LoopIteration });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toMatchObject({ newItemIds: [] });
    writeFileSync(paths.outstanding, '## For information\n- No further question.');
    await hook({ state, iteration: { seq: 3 } as LoopIteration });
    expect(store.listOutstandingItems().map(item => item.kind)).toEqual(['for-information']);
    // The decision cap survives recapture because it counts durable rows.
    writeFileSync(paths.outstanding, '## Decisions applied\n' + Array.from({ length: 10 }, (_, index) => `- Local helper ${index}\n  - Applied: Reuse it.`).join('\n'));
    await hook({ state, iteration: { seq: 4 } as LoopIteration });
    await hook({ state, iteration: { seq: 5 } as LoopIteration });
    expect(intervene.mock.calls.filter(call => String(call[1]).includes('10'))).toHaveLength(1);
    const saved = store.listOutstandingItems({ status: 'all' });
    writeFileSync(paths.outstanding, '## For information\n' + 'x'.repeat(130 * 1024));
    await hook({ state, iteration: { seq: 6 } as LoopIteration });
    expect(store.listOutstandingItems({ status: 'all' })).toEqual(saved);
    rmSync(paths.outstanding);
    await expect(hook({ state, iteration: { seq: 7 } as LoopIteration })).resolves.toBeUndefined();

  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
