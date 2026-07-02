import { describe, expect, it } from 'vitest';
import { ToolRwLock } from './tool-rw-lock';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('ToolRwLock', () => {
  it('allows overlapping reads on the same subtree', async () => {
    const lock = new ToolRwLock();
    const starts: number[] = [];

    await Promise.all([
      lock.runRead(['src/app'], async () => { starts.push(Date.now()); await delay(40); }),
      lock.runRead(['src/app/component.ts'], async () => { starts.push(Date.now()); await delay(40); }),
    ]);

    expect(Math.abs(starts[0] - starts[1])).toBeLessThan(25);
  });

  it('serializes overlapping writes on ancestor and descendant paths', async () => {
    const lock = new ToolRwLock();
    const starts: number[] = [];

    await Promise.all([
      lock.runWrite(['src/app'], async () => { starts.push(Date.now()); await delay(40); }),
      lock.runWrite(['src/app/component.ts'], async () => { starts.push(Date.now()); await delay(5); }),
    ]);

    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
  });

  it('allows disjoint writes to run in parallel', async () => {
    const lock = new ToolRwLock();
    const starts: number[] = [];

    await Promise.all([
      lock.runWrite(['src/app'], async () => { starts.push(Date.now()); await delay(40); }),
      lock.runWrite(['docs/plan.md'], async () => { starts.push(Date.now()); await delay(40); }),
    ]);

    expect(Math.abs(starts[0] - starts[1])).toBeLessThan(25);
  });

  it('cancels a pending waiter when its abort signal fires', async () => {
    const lock = new ToolRwLock();
    let releaseFirst!: () => void;
    const first = lock.runWrite(['src/app'], async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
    });
    await delay(0);

    const abort = new AbortController();
    const second = lock.runWrite(['src/app/component.ts'], async () => undefined, abort.signal);
    abort.abort();

    await expect(second).rejects.toThrow('lock acquisition aborted');
    releaseFirst();
    await first;
  });
});
