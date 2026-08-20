import { getHeapStatistics } from 'node:v8';
import { describe, expect, it } from 'vitest';

import { testHeapBudgetMb, testHeapExecArgv } from '../../vitest.heap';

/**
 * A full suite run on 2026-08-20 died at file 771 of 848 with
 * `FATAL ERROR: Ineffective mark-compacts near heap limit`: the singleFork
 * worker had grown into V8's default ~4 GB old-space ceiling, and the parent
 * then blew up with ERR_IPC_CHANNEL_CLOSED talking to the dead worker. The
 * ceiling is now raised through `poolOptions.forks.execArgv` in
 * vitest.config.ts / vitest.slow.config.ts.
 *
 * That wiring is invisible until a run dies eight minutes in, so this spec runs
 * inside the worker and checks the ceiling the worker actually got.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

describe('test worker heap budget', () => {
  it('keeps Node defaults on hosts too small to raise the ceiling safely', () => {
    expect(testHeapBudgetMb(8 * GB)).toBeNull();
    expect(testHeapExecArgv(8 * GB)).toEqual([]);
  });

  it('raises the ceiling to a quarter of host RAM, capped at 8 GB', () => {
    expect(testHeapBudgetMb(32 * GB)).toBe(8192);
    expect(testHeapBudgetMb(28 * GB)).toBe(7168);
    expect(testHeapExecArgv(128 * GB)).toEqual(['--max-old-space-size=8192']);
  });

  it('gives this worker the ceiling its host qualifies for', () => {
    const budget = testHeapBudgetMb();
    if (budget === null) {
      return; // Small host (CI runner): Node's own default is deliberate.
    }
    // heap_size_limit sits slightly above the requested old-space size.
    expect(getHeapStatistics().heap_size_limit).toBeGreaterThanOrEqual(budget * MB);
  });
});
