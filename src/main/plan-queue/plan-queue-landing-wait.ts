/**
 * Plan Queue landing wait — a landing the root checkout's uncommitted code is in the way of waits instead of parking.
 *
 * A passed item changes files that James (or another session) has uncommitted edits to in the root checkout. Promotion
 * refuses those, so the item used to park `land-blocked` and need a person to press Try again. It now stays in
 * `landing`, records `landingWaitSince` and the paths on its row, and holds nothing: no landing chain, no item lock,
 * no worker slot, no wake lock. The pump (and boot recovery) checks again each cycle and lands it when the paths are
 * clear. The clock starts at the first wait and runs for 24 hours, paused or not.
 *
 * Two checks feed the wait:
 *  - before the commit is built, so the repository's hook, which can take an hour, never runs for a landing whose
 *    edits would clash. Unstaged edits are test-merged here; the files the hook regenerates are left to promotion;
 *  - the structured `dirty-overlap` answer from promotion, for what only promotion can tell. Those paths are held on
 *    the row, so the landing waits for them without spending the hook again on every pass.
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { gitExec } from '../workspace/git/git-exec';
import { readGitStatusPaths } from '../workspace/git/git-status-stream';
import { pathsCollide } from '../workspace/git/worktree-integration';
import { rootEditWouldMerge } from './plan-queue-doc-merge';
import { GENERATED_STATUSES, loadGeneratedFiles } from './plan-queue-generated-files';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { isLandingWait } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

/** After this long a waiting landing parks `land-blocked`, and Try again resumes it. */
export const LANDING_WAIT_LIMIT_MS = 24 * 60 * 60_000;
/** Waiting landings per run; further ones park straight away, as before. */
export const MAX_LANDING_WAITERS = 3;
const NAMED_PATHS = 5;

interface RootChange { path: string; status: string }

function listPaths(paths: readonly string[]): string {
  return paths.length > NAMED_PATHS ? `${paths.slice(0, NAMED_PATHS).join(', ')} and ${paths.length - NAMED_PATHS} more` : paths.join(', ');
}

/** Why a landing cannot go ahead, as the parked note or the one message to James. */
export function overlapReason(paths: readonly string[]): string {
  return `The main folder has uncommitted changes to ${listPaths(paths)}, which this item also changes.`;
}

async function readRootChanges(repoRoot: string): Promise<RootChange[]> {
  const changes: RootChange[] = [];
  await readGitStatusPaths(repoRoot, (filePath, status) => { changes.push({ path: filePath.replace(/\/$/, ''), status }); });
  return changes;
}

/**
 * Root paths with uncommitted changes that the item's landing would also change and that promotion cannot resolve.
 * Reads the committed branch, so the item's final checkpoint must already be made.
 */
async function overlappingRootPaths(item: PlanQueueItem, run: PlanQueueRun, changes: readonly RootChange[]): Promise<string[]> {
  const { worktreePath, branchName } = item;
  if (!worktreePath || !branchName) throw new Error(`Plan queue item ${item.id} has no work folder to compare`);
  const repoRoot = run.workspaceCwd;
  const baseRef = `refs/heads/${run.config.baseBranch}`;
  const forkPoint = await gitExec(['merge-base', baseRef, 'HEAD'], worktreePath);
  const changed = (await gitExec(['diff', '--name-only', '--no-renames', '-z', forkPoint, 'HEAD'], worktreePath)).split('\0').filter(Boolean);
  const overlaps = changes.filter((change) => changed.some((file) => pathsCollide(change.path, file)));
  if (!overlaps.length) return [];
  const baseTip = await gitExec(['rev-parse', baseRef], repoRoot);
  const head = await gitExec(['rev-parse', 'HEAD'], worktreePath);
  const generated = overlaps.some((change) => !/\.md$/i.test(change.path)) ? await loadGeneratedFiles(repoRoot, baseTip, head) : null;
  const blocked = new Set<string>();
  for (const change of overlaps) {
    const resolvable = generated?.artifacts.has(change.path) ? GENERATED_STATUSES.includes(change.status)
      : change.status === '??' || (change.status === ' M' && await rootEditWouldMerge(repoRoot, baseTip, head, change.path));
    if (!resolvable) blocked.add(change.path);
  }
  return [...blocked];
}

/** The paths that still stop this item landing: the pre-commit check's, plus any promotion refused that remain changed. */
export async function landingBlockers(item: PlanQueueItem, run: PlanQueueRun): Promise<string[]> {
  const changes = await readRootChanges(run.workspaceCwd);
  const held = (item.landingWaitPaths ?? []).filter((file) => changes.some((change) => pathsCollide(change.path, file)));
  return [...new Set([...await overlappingRootPaths(item, run, changes), ...held])];
}

interface LandingWaitPorts {
  readonly host: Pick<PlanQueueFlowHost, 'getRun' | 'getItem' | 'save' | 'store' | 'notifyParent'>;
  /** The item's operation lock, so a re-check never overlaps a landing attempt or a park. */
  lock<T>(itemId: string, action: () => Promise<T>): Promise<T>;
  enqueueLanding(itemId: string): Promise<void>;
  /** Park with the item lock already held. */
  park(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string): Promise<void>;
  now?: () => number;
}

export class PlanQueueLandingWaits {
  private readonly now: () => number;
  constructor(private readonly ports: LandingWaitPorts) { this.now = ports.now ?? Date.now; }

  /**
   * Put a landing that cannot go ahead into its wait. Called from the landing, with the item lock held.
   * Returns null once the item waits, or the note to park it with when it may not (the run's waiting places
   * are full, or it has already waited the full time).
   */
  begin(item: PlanQueueItem, paths: readonly string[], reason: string): string | null {
    const { host } = this.ports;
    const now = this.now();
    const since = item.landingWaitSince ?? now;
    if (now - since >= LANDING_WAIT_LIMIT_MS) return `Not landed. ${reason} It waited 24 hours, so it stopped waiting. Try merging again lands it once these are committed or put away.`;
    if (host.store.listItems(item.runId).filter((other) => other.id !== item.id && isLandingWait(other)).length >= MAX_LANDING_WAITERS) {
      return `Not landed. ${reason} ${MAX_LANDING_WAITERS} other items in this run are already waiting to land, so this one stopped. Try merging again lands it once these are committed or put away.`;
    }
    host.save({ ...item, landingWaitSince: since, landingWaitPaths: [...paths],
      detail: `Waiting to land. ${reason} It lands by itself once these are committed or put away.` });
    // Told once: a re-wait after an attempt keeps the original time, so it does not tell James again.
    if (item.landingWaitSince == null) {
      const run = host.getRun(item.runId);
      host.notifyParent(run, `${path.basename(item.documentPath)} passed its checks but cannot land yet. ${reason} It lands by itself once these are committed or put away, and stops after 24 hours.`);
    }
    return null;
  }

  /** Pump and boot recovery: land the item if its paths are clear, park it after 24 hours, otherwise keep waiting. */
  recheck(itemId: string): Promise<void> {
    return this.ports.lock(itemId, async () => {
      const item = this.ports.host.getItem(itemId);
      const run = this.ports.host.getRun(item.runId);
      if (!isLandingWait(item) || run.status !== 'running') return;
      const paths = item.landingWaitPaths ?? [];
      // What can't be compared goes to the landing, which says what is wrong; a wait must not hide it for ever.
      const remaining = item.worktreePath && existsSync(item.worktreePath) ? await landingBlockers(item, run).catch(() => []) : [];
      if (remaining.length) {
        if (this.now() - (item.landingWaitSince ?? 0) >= LANDING_WAIT_LIMIT_MS) {
          await this.ports.park(item, 'land-blocked', `Not landed. ${overlapReason(remaining)} It waited 24 hours, so it stopped waiting. Try merging again lands it once these are committed or put away.`);
          return;
        }
        if (remaining.join('\0') !== paths.join('\0')) {
          this.ports.host.save({ ...item, landingWaitPaths: remaining,
            detail: `Waiting to land. ${overlapReason(remaining)} It lands by itself once these are committed or put away.` });
        }
        return;
      }
      // Clear: the landing takes over (and syncs with a moved base first). The wait time stays for the 24-hour count.
      this.ports.host.save({ ...item, landingWaitPaths: [], detail: null });
      void this.ports.enqueueLanding(itemId);
    });
  }
}
