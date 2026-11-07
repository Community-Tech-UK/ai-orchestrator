import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { preflightResumedRun } from './plan-queue-run-preflight';
import type { PlanQueueRun } from './plan-queue.types';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-preflight-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Queue Test'); git('config', 'user.email', 'queue@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'a\n'); git('add', '-A'); git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const run = (): PlanQueueRun => ({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
  status: 'completed', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', verifierGates: [], postMergeGate: [] },
  relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: 2 });
const anyChecker = vi.fn(async () => ({ ok: true }) as never);

describe('preflightResumedRun', () => {
  it('lets a run carry on when nothing has changed', async () => {
    await expect(preflightResumedRun(run(), anyChecker)).resolves.toBeUndefined();
  });

  it('refuses when the main folder has moved to another branch, which would land the work there', async () => {
    git('checkout', '-qb', 'something-else');
    await expect(preflightResumedRun(run(), anyChecker)).rejects.toThrow(/on something-else, but the run lands its work on main/);
  });

  it('refuses when no checker can be chosen any more', async () => {
    await expect(preflightResumedRun(run(), vi.fn(async () => ({ ok: false, reason: 'no allowed checker' }) as never)))
      .rejects.toThrow(/no allowed checker/);
  });
});
