import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotEventsTail } from './copilot-events-tail';

/**
 * A same-size rewrite inside one clock tick, which a Mac's nanosecond timestamps can't show.
 * Linux stamps files from a clock that ticks every few milliseconds, so two quick writes look
 * identical to `stat`. Freezing both timestamps here makes that the case on every machine.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const realStat = handle.stat.bind(handle);
      handle.stat = (async (options: never) => {
        const stats = await realStat(options);
        return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { mtimeNs: 1n, ctimeNs: 1n });
      }) as typeof handle.stat;
      return handle;
    },
  };
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const shutdown = (total: number) => `${JSON.stringify({ type: 'session.shutdown', data: { totalPremiumRequests: total } })}\n`;

describe('Copilot events tail within one clock tick', () => {
  it('sees a same-size rewrite that leaves size and both timestamps unchanged', async () => {
    const home = await mkdtemp(join(tmpdir(), 'copilot-tail-tick-'));
    roots.push(home);
    const dir = join(home, 'session-state', 'session-1');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'events.jsonl');
    const tail = new CopilotEventsTail(home, 'session-1');

    await writeFile(file, shutdown(2));
    expect((await tail.poll()).premiumRequests).toBe(2);

    await writeFile(file, shutdown(7));
    expect((await tail.poll()).premiumRequests).toBe(7);
  });

  it('still returns the cached figures when nothing changed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'copilot-tail-tick-'));
    roots.push(home);
    const dir = join(home, 'session-state', 'session-1');
    await mkdir(dir, { recursive: true });
    const tail = new CopilotEventsTail(home, 'session-1');

    await writeFile(join(dir, 'events.jsonl'), shutdown(2));
    expect((await tail.poll()).premiumRequests).toBe(2);
    expect((await tail.poll()).premiumRequests).toBe(2);
  });
});
