import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlanQueueWorkerSessions } from './plan-queue-worker-sessions';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

function setup(kind: 'plans' | 'livetests', itemPatch: Partial<PlanQueueItem> = {}) {
  let item = newPlanQueueItem('item-aaaa1111', 'run', '/repo/docs/a_livetest.md', 1, itemPatch);
  const host = {
    getItem: () => item,
    save: vi.fn((next: PlanQueueItem) => (item = next)),
    livetestPortsInUse: vi.fn(() => [] as number[]),
  } as unknown as PlanQueueFlowHost;
  const sessions = new PlanQueueWorkerSessions({ host, lock: vi.fn(), stop: vi.fn(), spawn: vi.fn(), failed: vi.fn() });
  return { sessions, host, run: { id: 'run', kind } as PlanQueueRun, current: () => item };
}

describe('PlanQueueWorkerSessions.withLivetestPort', () => {
  it('records a free port on a livetest item before its worker is prompted', async () => {
    const { sessions, run, host, current } = setup('livetests');
    const result = await sessions.withLivetestPort(current(), run);
    expect(result.livetestPort).toBeGreaterThanOrEqual(9500);
    expect(host.save).toHaveBeenCalledOnce();
    expect(current().livetestPort).toBe(result.livetestPort);
  });

  it('leaves a plan item alone', async () => {
    const { sessions, run, host, current } = setup('plans');
    expect(await sessions.withLivetestPort(current(), run)).toBe(current());
    expect(host.save).not.toHaveBeenCalled();
  });

  it('after a restart, records a port for an item that never got one but keeps one it already has', async () => {
    const fresh = setup('livetests');
    expect((await fresh.sessions.withLivetestPort(fresh.current(), fresh.run, true)).livetestPort).toBeGreaterThanOrEqual(9500);

    // The dead worker's dev app may still hold the recorded port, so it is not checked or replaced.
    const recorded = setup('livetests', { livetestPort: 9123 });
    const result = await recorded.sessions.withLivetestPort(recorded.current(), recorded.run, true);
    expect(result.livetestPort).toBe(9123);
    expect(recorded.host.save).not.toHaveBeenCalled();
  });

  it('on a normal start, replaces a recorded port that something else now holds', async () => {
    const { sessions, run, host, current } = setup('livetests', { livetestPort: 9123 });
    (host.livetestPortsInUse as ReturnType<typeof vi.fn>).mockReturnValue([9123]);
    const result = await sessions.withLivetestPort(current(), run);
    expect(result.livetestPort).not.toBe(9123);
  });
});

describe('PlanQueueWorkerSessions.promptContext', () => {
  it('reads a plan\'s Status and open work for its worker, and none for a livetest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompt-context-'));
    try {
      const file = join(dir, 'a_plan.md');
      writeFileSync(file, '# A\n\n## Status\nNext: Step 2\n\n## Open\n- [ ] Open item\n');
      const plans = setup('plans', { sourceRef: file });
      const context = await plans.sessions.promptContext(plans.run, plans.current());
      expect(context.brief).toEqual({ status: 'Next: Step 2', acceptance: '- [ ] Open item' });
      const livetests = setup('livetests');
      expect(await livetests.sessions.promptContext(livetests.run, livetests.current())).not.toHaveProperty('brief');
      expect(plans.sessions.continueContext(plans.run, plans.current())).not.toHaveProperty('brief');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
