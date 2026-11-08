/**
 * Step 3.2: a job that passed its checks but was set aside at landing is tried again by Harness itself, so passed work
 * doesn't go stale while nobody looks. A day after each stop it tries once, and only if the branch still merges with
 * the base, apart from the live-test register, which the merge settles. Its run isn't reopened, so no summary is sent
 * and a cancelled run is never touched; restart recovery finds these landings itself. It never waits for uncommitted
 * edits, and never starts a worker turn (`landingAutomatic`): anything a worker would fix sets it aside again with its
 * pass. Two weeks after the pass it stops trying and waits for James. No new try starts while any run is paused.
 */
import { getLogger } from '../logging/logger';
import { existsSync } from 'node:fs';
import { gitExec } from '../workspace/git/git-exec';
import { mergeInProgress } from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueLandingRetries');
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
export const LANDING_RETRY_AFTER_MS = DAY;
export const LANDING_RETRY_GIVE_UP_MS = 14 * DAY;
export const MAX_AUTOMATIC_LANDINGS = 2;
const LIVETEST_REGISTER_PATH = 'docs/plans/livetest-remediation-register.md';

/** True when the branch merges with the base, or clashes only in the register. Read-only. */
export async function mergesWithBase(repoRoot: string, baseBranch: string, branchName: string): Promise<boolean> {
  try {
    await gitExec(['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/heads/${baseBranch}`, `refs/heads/${branchName}`], repoRoot);
    return true;
  } catch (error) {
    const output = String((error as { stdout?: unknown }).stdout ?? '');
    const clashes = output.split('\n').slice(1).filter(Boolean);
    return (error as { code?: unknown }).code === 1 && clashes.length > 0 && clashes.every(file => file === LIVETEST_REGISTER_PATH);
  }
}

export class PlanQueueLandingRetries {
  /** Each job is looked at once an hour at most, whatever the outcome. */
  private readonly lookAt = new Map<string, number>();
  private running = false;

  constructor(
    private readonly host: Pick<PlanQueueFlowHost, 'store' | 'history' | 'getRun'>,
    private readonly retry: (itemId: string) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async retryDue(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { store } = this.host;
      if (store.listActiveRuns().some(run => run.status === 'paused')) return;
      let started = store.countAutomaticLandings();
      for (const item of store.listPassedLandingParks()) {
        if (started >= MAX_AUTOMATIC_LANDINGS) return;
        const now = this.now();
        if ((this.lookAt.get(item.id) ?? 0) > now) continue;
        this.lookAt.set(item.id, now + HOUR);
        try {
          if (!await this.due(item, now)) continue;
          await this.retry(item.id);
          started += 1;
          logger.info('Plan queue: trying a passed landing again by itself', { itemId: item.id });
        } catch (error) {
          // Its folder couldn't be set up, or the job changed meanwhile: the next look tries again.
          logger.info('Plan queue: a passed landing could not be retried yet', { itemId: item.id, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } finally { this.running = false; }
  }

  private async due(item: PlanQueueItem, now: number): Promise<boolean> {
    const { store, history } = this.host;
    if (now - (store.lastParkedAt(item.id) ?? item.updatedAt) < LANDING_RETRY_AFTER_MS) return false;
    const passedAt = history.listVerdicts(item.id).filter(verdict => verdict.verdict === 'PASS').at(-1)?.at;
    if (passedAt === undefined || now - passedAt > LANDING_RETRY_GIVE_UP_MS) return false;
    if (store.newerAttemptLanded(item) || store.documentInPlay(item)) return false;
    // A worker's unfinished conflict fix may be in the folder; a retry would abort that merge and lose it.
    if (item.worktreePath && existsSync(item.worktreePath) && await mergeInProgress(item.worktreePath)) return false;
    const run = this.host.getRun(item.runId);
    return mergesWithBase(run.workspaceCwd, run.config.baseBranch!, item.branchName!);
  }
}
