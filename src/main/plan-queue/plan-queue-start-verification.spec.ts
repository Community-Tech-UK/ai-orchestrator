import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newPlanQueueItem } from './plan-queue-state';
import { startQueueVerification } from './plan-queue-start-verification';

describe('a job whose plan is gone when its checks start', () => {
  let repo: string;
  beforeEach(() => { repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-start-check-'))); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('is set aside with the real reason, before any check runs', async () => {
    const document = join(repo, 'old_livetest.md');
    writeFileSync(join(repo, 'old_livetest_completed.md'), 'Closed elsewhere');
    const item = newPlanQueueItem('job', 'run', document, 1, { state: 'verifying', branchName: 'queue/old', worktreePath: join(repo, 'wt') });
    const park = vi.fn(async () => undefined);
    const prepare = vi.fn();
    const reattach = vi.fn();
    await startQueueVerification({
      host: { getItem: () => item, getRun: () => ({ id: 'run', status: 'running', workspaceCwd: repo, config: { baseBranch: 'main' } }), worktrees: { reattach } } as never,
      verification: { prepare, prepareGrouped: prepare } as never,
      hold: vi.fn(), park, fix: vi.fn(), spawn: vi.fn(), checksFinished: vi.fn(), checksFailed: vi.fn(), holdOff: vi.fn(),
    }, item.id);
    expect(park).toHaveBeenCalledWith(item, 'missing-document', expect.stringContaining('closed as old_livetest_completed.md'));
    expect(prepare).not.toHaveBeenCalled();
    expect(reattach).not.toHaveBeenCalled();
  });
});

describe('a job whose checks no test machine could take', () => {
  let repo: string;
  beforeEach(() => { repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-start-not-run-'))); });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('waits for a slot with the reason and is kept back for a few minutes, not sent back to fix anything', async () => {
    const document = join(repo, 'work_plan.md');
    writeFileSync(document, '# Work');
    mkdirSync(join(repo, 'wt', '.git'), { recursive: true });
    const item = newPlanQueueItem('job', 'run', document, 1, { state: 'verifying', branchName: 'queue/work', worktreePath: join(repo, 'wt') });
    const detail = 'Waiting for a test machine: both test machines are paused.';
    const prepareGrouped = vi.fn(async () => ({ kind: 'wait', detail, retryMs: 300_000 }));
    const transition = vi.fn();
    const ctx = { hold: vi.fn(), park: vi.fn(), fix: vi.fn(), spawn: vi.fn(), checksFinished: vi.fn(), checksFailed: vi.fn(), holdOff: vi.fn() };
    await startQueueVerification({
      host: { getItem: () => item, getRun: () => ({ id: 'run', status: 'running', workspaceCwd: repo, config: { baseBranch: 'main' } }), transition } as never,
      verification: { prepareGrouped, prepare: vi.fn() } as never, ...ctx,
    }, item.id);
    expect(ctx.holdOff).toHaveBeenCalledWith('job', 300_000);
    expect(transition).toHaveBeenCalledWith(item, 'awaiting-slot', { detail });
    expect(ctx.checksFinished).toHaveBeenCalledWith(false);
    expect(ctx.fix).not.toHaveBeenCalled();
    expect(ctx.park).not.toHaveBeenCalled();
  });
});
