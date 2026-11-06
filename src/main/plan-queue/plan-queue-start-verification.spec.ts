import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
      hold: vi.fn(), park, fix: vi.fn(), spawn: vi.fn(), checksFinished: vi.fn(), checksFailed: vi.fn(),
    }, item.id);
    expect(park).toHaveBeenCalledWith(item, 'missing-document', expect.stringContaining('closed as old_livetest_completed.md'));
    expect(prepare).not.toHaveBeenCalled();
    expect(reattach).not.toHaveBeenCalled();
  });
});
