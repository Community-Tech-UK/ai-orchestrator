import { app } from 'electron';
import { join } from 'node:path';
import { LeftoverWorktreeArchiveService } from './leftover-worktree-archive';
import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { LeftoverWorktreeReport } from '@contracts/schemas/workspace-tools';
import { getLoopStoreService } from '../../orchestration/loop-store-service';
import { PlanQueueStore } from '../../plan-queue/plan-queue-store';
import { isTerminalItemState } from '../../plan-queue/plan-queue-state';
import { pathCompareKey } from '../../util/path-helpers';
import { buildLeftoverWorktreeReport, parseLeftoverWorktrees, type LeftoverReportDependencies, type RecordedWorktreeOwner } from './leftover-worktree-report';
import { gitExec } from './git-exec';

interface OwnerStore {
  getPendingWorktreeLifecycles(): { id: string; status: string; workspaceCwd: string;
    worktreePath: string | null; lifecycle: { phase: string } }[];
  listResumableRuns(): { runRow: { id: string; status: string; worktree_path: string | null };
    config: { workspaceCwd?: string } }[];
}
interface QueueOwnerItem {
  id: string; runId: string; state: PlanQueueItemState; worktreePath: string | null;
}
export interface LeftoverLiveSession { id: string; cwd: string | undefined; status: string }

/** No history limits: old owners must never disappear because new runs arrived. */
export function collectLeftoverOwners(store: OwnerStore, queueItems: QueueOwnerItem[],
  queueRoots: ReadonlyMap<string, string>): RecordedWorktreeOwner[] {
  const owners: RecordedWorktreeOwner[] = store.getPendingWorktreeLifecycles().flatMap((run) => run.worktreePath
    ? [{ path: run.worktreePath, repoRoot: run.workspaceCwd, kind: 'loop' as const, id: run.id,
      status: run.status, phase: run.lifecycle.phase,
      inUse: run.status === 'running' || run.status === 'paused' }] : []);
  for (const { runRow: run, config } of store.listResumableRuns()) {
    if (run.worktree_path && config.workspaceCwd) owners.push({ path: run.worktree_path,
      repoRoot: config.workspaceCwd, kind: 'loop', id: run.id, status: run.status, inUse: true });
  }
  for (const item of queueItems) {
    const repoRoot = queueRoots.get(item.runId);
    if (item.worktreePath && repoRoot) owners.push({ path: item.worktreePath, repoRoot, kind: 'queue',
      id: item.id, status: item.state, inUse: !isTerminalItemState(item.state) });
  }
  return owners;
}

export function createLeftoverRuntimeDependencies(getLiveSessions: () => LeftoverLiveSession[]): LeftoverReportDependencies {
  return {
    currentCheckout: process.cwd(),
    archiveRoot: join(app.getPath('userData'), 'work-folder-archives'),
    owners: () => {
      const service = getLoopStoreService();
      const db = service.getDb();
      if (!db) throw new Error('Work folder ownership database is unavailable');
      const roots = new Map(db.prepare('SELECT id, workspace_cwd FROM plan_queue_runs').all<{
        id: string; workspace_cwd: string;
      }>().map((r) => [r.id, r.workspace_cwd]));
      return collectLeftoverOwners(service.store, new PlanQueueStore(db).listItemsWithGitOwnership(), roots);
    },
    liveSessions: () => getLiveSessions().flatMap((s) => s.cwd && s.status !== 'terminated' && s.status !== 'failed'
      ? [{ id: s.id, cwd: s.cwd, status: s.status }] : []),
  };
}

export async function listRuntimeLeftoverWorktrees(deps: LeftoverReportDependencies,
  workingDirectory?: string): Promise<LeftoverWorktreeReport> {
  const service = getLoopStoreService();
  const db = service.getDb();
  if (!db) throw new Error('Work folder ownership database is unavailable');
  const roots = new Set<string>(new PlanQueueStore(db).listWorkspaceRoots());
  // Include recorded loop paths even after their lifecycle is cleaned. Their
  // workspace can still contain report-only folders that no owner recognises.
  for (const row of db.prepare('SELECT config_json FROM loop_runs WHERE worktree_path IS NOT NULL')
    .all<{ config_json: string }>()) {
    const config: unknown = JSON.parse(row.config_json);
    if (config && typeof config === 'object' && 'workspaceCwd' in config && typeof config.workspaceCwd === 'string') {
      roots.add(config.workspaceCwd);
    }
  }
  if (workingDirectory) roots.add(workingDirectory);
  for (const s of deps.liveSessions()) roots.add(s.cwd);
  if (deps.currentCheckout) roots.add(deps.currentCheckout);
  const result: LeftoverWorktreeReport = { rows: [], errors: [] };
  const seen = new Set<string>();
  const inspectedRepositories = new Set<string>();
  // Sequential repositories bound Git process and filesystem concurrency.
  for (const root of roots) {
    try {
      // Several live sessions may have different cwd values in linked checkouts
      // of the same repository. Resolve their shared main checkout once before
      // doing the per-folder Git reads, rather than scanning every folder N times.
      const listed = parseLeftoverWorktrees(await (deps.git ?? gitExec)(
        ['--no-optional-locks', 'worktree', 'list', '--porcelain', '-z'], root));
      const mainRoot = listed[0]?.path;
      if (!mainRoot) throw new Error('Git did not report a main checkout');
      const repositoryKey = pathCompareKey(mainRoot);
      if (inspectedRepositories.has(repositoryKey)) continue;
      inspectedRepositories.add(repositoryKey);
      const report = await buildLeftoverWorktreeReport(mainRoot, deps);
      for (const row of report.rows) {
        const key = pathCompareKey(row.path);
        if (!seen.has(key)) { seen.add(key); result.rows.push(row); }
      }
      result.errors.push(...report.errors);
      if (deps.archiveRoot) {
        result.archives ??= [];
        result.archives.push(...await new LeftoverWorktreeArchiveService(deps.archiveRoot).list(mainRoot));
      }
    } catch (error) {
      result.errors.push({ repoRoot: root, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
