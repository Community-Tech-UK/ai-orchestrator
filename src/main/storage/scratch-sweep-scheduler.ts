import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getNotificationService } from '../notifications/notification-service';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import { gitExec } from '../workspace/git/git-exec';
import { sweepScratchFolders, type ScratchEntryDecision } from './scratch-sweep';

const logger = getLogger('ScratchSweep');

/** Let startup settle before walking project folders. */
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_PATHS_IN_NOTIFICATION = 3;

let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;
const reportedUnsavedPaths = new Set<string>();

/** Local project folders the user has opened, mapped to their repository roots. */
async function listProjectRoots(): Promise<string[]> {
  const entries = await getRecentDirectoriesManager().getDirectories();
  const roots = new Set<string>();
  for (const entry of entries) {
    if (entry.nodeId) continue;
    const top = await gitExec(['rev-parse', '--show-toplevel'], entry.path).catch(() => '');
    roots.add(path.resolve(top || entry.path));
  }
  return [...roots];
}

export async function runScratchSweep(): Promise<ScratchEntryDecision[]> {
  if (sweepRunning) return [];
  sweepRunning = true;
  try {
    const retentionDays = getSettingsManager().get('scratchRetentionDays');
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
    const decisions = await sweepScratchFolders({ projectRoots: await listProjectRoots(), retentionDays });
    const removed = decisions.filter((decision) => decision.kind === 'removed');
    const failed = decisions.filter((decision) => decision.kind === 'failed');
    const unsaved = decisions.filter(
      (decision): decision is Extract<ScratchEntryDecision, { kind: 'kept-unsaved-work' }> =>
        decision.kind === 'kept-unsaved-work',
    );
    if (removed.length > 0 || failed.length > 0 || unsaved.length > 0) {
      logger.info('Swept old scratch folders', {
        removed: removed.length,
        keptWithUnsavedWork: unsaved.map((decision) => ({ path: decision.path, reason: decision.reason })),
        failed: failed.map((decision) => ({ path: decision.path, error: decision.error })),
      });
    }
    notifyNewUnsavedWork(unsaved.map((decision) => decision.path), retentionDays);
    return decisions;
  } catch (error) {
    logger.warn('Scratch sweep failed', { error: error instanceof Error ? error.message : String(error) });
    return [];
  } finally {
    sweepRunning = false;
  }
}

function notifyNewUnsavedWork(paths: readonly string[], retentionDays: number): void {
  const fresh = paths.filter((entryPath) => !reportedUnsavedPaths.has(entryPath));
  for (const entryPath of fresh) reportedUnsavedPaths.add(entryPath);
  if (fresh.length === 0) return;
  const listed = fresh.slice(0, MAX_PATHS_IN_NOTIFICATION).join(', ');
  const more = fresh.length > MAX_PATHS_IN_NOTIFICATION ? ` and ${fresh.length - MAX_PATHS_IN_NOTIFICATION} more` : '';
  getNotificationService().notify({
    kind: 'scratch-unsaved-work',
    title: 'Old scratch folders kept: they hold unsaved work',
    body: `Harness did not delete ${fresh.length} scratch folder(s) older than ${retentionDays} days because they contain `
      + `changes that are not in the project yet: ${listed}${more}. Save what you need, then delete them.`,
    fingerprintFields: { paths: fresh },
  });
}

export function startScratchSweepScheduler(): void {
  if (firstSweepTimer || intervalTimer) return;
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    void runScratchSweep();
    intervalTimer = setInterval(() => { void runScratchSweep(); }, SWEEP_INTERVAL_MS);
    intervalTimer.unref?.();
  }, FIRST_SWEEP_DELAY_MS);
  firstSweepTimer.unref?.();
}

export function _resetForTesting(): void {
  if (firstSweepTimer) clearTimeout(firstSweepTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstSweepTimer = null;
  intervalTimer = null;
  sweepRunning = false;
  reportedUnsavedPaths.clear();
}
