import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readDocumentReview } from './plan-queue-document-review';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { prepareClosedDocuments, retireActiveDocuments } from './plan-queue-doc-close';
import { landItemBranch } from './plan-queue-landing';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const guard = join(homedir(), '.config/git/hooks/plan-spec-guard.sh');
let repo: string;
let item: PlanQueueItem;
let service: PlanQueueWorktreeService;
const history = 'docs/shared_history.md';
const baseHistory = '# Earlier records\nPreserve the baseline. \n\n';
const candidateHistory = `${baseHistory}## Candidate\nWorker evidence. \n\n`;
const rootHistory = `${baseHistory}## Root\nConcurrent root evidence. \n\n`;
const git = (args: string[], cwd = repo) => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-history-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']);
  git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'docs'));
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, history), baseHistory);
  git(['add', '.']);
  git(['commit', '--no-verify', '-qm', 'tracked legacy history']);
  const worktreePath = join(repo, '.worktrees/queue/history');
  git(['worktree', 'add', '-qb', 'queue/history', worktreePath]);
  item = newPlanQueueItem('history-item', 'run', join(repo, 'docs/shared_plan.md'), 1, {
    state: 'landing', worktreePath, branchName: 'queue/history', baseCommit: git(['rev-parse', 'main']),
  });
  writeFileSync(item.documentPath, '# Plan\n## As-built\nImplemented.\n');
  writeFileSync(join(repo, 'docs/shared_livetest.md'), '# Still open\n');
  service = new PlanQueueWorktreeService({ repoRootForItem: () => repo,
    creator: { getAllSessions: () => [], createWorktree: vi.fn(), cleanupWorktree: vi.fn() },
    saveItem: saved => { item = saved; }, skipInstall: true,
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

async function prepare() {
  const prepared = await prepareClosedDocuments(item.documentPath, repo, item.worktreePath, null);
  if (prepared.mode !== 'commit') throw new Error('Expected committed closure');
  return prepared.documents;
}

function installGuard(failAfterGuard = false) {
  const hooks = join(repo, '.git/history-hooks');
  mkdirSync(hooks, { recursive: true });
  // Run the actual installed guard, with no escape hatch or test reimplementation.
  writeFileSync(join(hooks, 'guard'), readFileSync(guard));
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\n"$(dirname "$0")/guard" || exit $?\n'
    + (failAfterGuard ? 'echo interrupted-after-guard >&2\nexit 1\n' : 'echo guard-passed >> "$(git rev-parse --git-common-dir)/history-guard-runs"\n'));
  chmodSync(join(hooks, 'guard'), 0o755);
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(['config', 'core.hooksPath', hooks]);
}

describe.skipIf(!existsSync(guard))('coordinator history closure with the installed lifecycle guard', () => {
  it('runs the production coordinator closure path after recovery of a verified landing', async () => {
    PlanQueueCoordinator._resetForTesting();
    const db = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    const run: PlanQueueRun = { id: item.runId, parentInstanceId: 'parent', parentHistoryThreadId: null,
      kind: 'plans', workspaceCwd: repo, status: 'running',
      config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main' },
      relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null };
    store.upsertRun(run);
    store.upsertItem({ ...item, verdict: { verdict: 'PASS', documentComplete: true, gatesRun: [], needJames: [], notChecked: [], findings: [] } });
    store.history.recordVerdict({ itemId: item.id, runId: item.runId, round: 1, verdict: 'PASS', findings: [], gatesRun: [],
      documentReview: await readDocumentReview(item.documentPath),
      notChecked: [], worktreeHead: item.checkpointCommit, documentSha256: createHash('sha256').update(readFileSync(item.documentPath)).digest('hex') });
    const instances = Object.assign(new EventEmitter(), {
      getInstance: () => undefined, getAllInstances: () => [], adoptOrphanInstance: () => false,
      createInstance: vi.fn(), sendInput: vi.fn(), terminateInstance: vi.fn(), restartFreshInstance: vi.fn(),
    });
    const coordinator = PlanQueueCoordinator.getInstance();
    coordinator.initialize({ store, instances, skipInstall: true, pumpIntervalMs: null,
      worktreeCreator: { getAllSessions: () => [], createWorktree: vi.fn(), cleanupWorktree: vi.fn() },
    });
    try {
      writeFileSync(join(item.worktreePath!, history), candidateHistory);
      writeFileSync(join(repo, history), rootHistory);
      installGuard();
      await coordinator.recover();
      await coordinator._whenSettledForTesting();
      expect(store.getItem(item.id)).toMatchObject({ state: 'landed', branchName: null, worktreePath: null });
      const names = git(['ls-tree', '-r', '--name-only', 'main']).split('\n');
      const immutable = names.find(name => /_history_[a-f0-9]{64}_completed.md$/.test(name))!;
      expect(readFileSync(join(repo, immutable), 'utf8')).toContain(candidateHistory);
      expect(readFileSync(join(repo, immutable), 'utf8')).toContain(rootHistory);
      expect(readFileSync(join(repo, history), 'utf8')).toBe(rootHistory);
      expect(existsSync(item.documentPath)).toBe(false);
      expect(existsSync(join(repo, 'docs/shared_livetest.md'))).toBe(true);
      expect(readFileSync(join(repo, '.git/history-guard-runs'), 'utf8')).toBe('guard-passed\n');
    } finally {
      coordinator.shutdown();
      await coordinator._whenSettledForTesting();
      PlanQueueCoordinator._resetForTesting();
      db.close();
    }
  });

  it('checkpoints tracked shared history and lands all records as completed evidence while retaining root edits', async () => {
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    writeFileSync(join(item.worktreePath!, 'feature.txt'), 'implemented\n');
    writeFileSync(join(repo, history), rootHistory);
    writeFileSync(join(repo, 'unrelated.txt'), 'unrelated staged work\n');
    git(['add', 'unrelated.txt']);
    item = await service.checkpoint(item, 'verified candidate');
    const checkpoint = item.checkpointCommit;
    const staged = git(['diff', '--cached', '--binary']);
    const documents = await prepare();
    // An edit after preparation must also survive; it is not in this snapshot.
    writeFileSync(join(repo, history), `${rootHistory}## Later\nDo not overwrite.\n`);
    installGuard();

    const result = await landItemBranch(item, repo, 'main', 'Plan: shared', documents);

    expect(result.status).toBe('landed');
    const immutable = documents.find(doc => /_history_[a-f0-9]{64}_completed.md$/.test(doc.relativePath))!;
    expect(readFileSync(join(repo, immutable.relativePath), 'utf8')).toContain(candidateHistory);
    expect(readFileSync(join(repo, immutable.relativePath), 'utf8')).toContain(rootHistory);
    expect(git(['diff', 'main^', 'main', '--', history])).toBe('');
    expect(readFileSync(join(repo, history), 'utf8')).toBe(`${rootHistory}## Later\nDo not overwrite.\n`);
    expect(git(['diff', '--cached', '--binary'])).toBe(staged);
    expect(readFileSync(join(repo, 'docs/shared_livetest.md'), 'utf8')).toBe('# Still open\n');
    expect(readFileSync(join(repo, '.git/history-guard-runs'), 'utf8')).toBe('guard-passed\n');
    expect(git(['rev-parse', item.branchName!])).toBe(checkpoint);
    expect(readFileSync(join(item.worktreePath!, history), 'utf8')).toBe(candidateHistory);
    expect(await retireActiveDocuments(item.documentPath, repo, 'main', null)).toEqual([expect.stringContaining('Kept shared_plan.md')]);
    expect(existsSync(item.documentPath)).toBe(true);
  });

  it('retries after a refusing hook and resumes a recorded commit without replacing closed evidence', async () => {
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    writeFileSync(join(repo, history), rootHistory);
    item = await service.checkpoint(item, 'final');
    const documents = await prepare();
    const main = git(['rev-parse', 'main']);
    installGuard(true);
    expect(await landItemBranch(item, repo, 'main', 'Plan: shared', documents))
      .toMatchObject({ status: 'hook-failed', output: expect.stringContaining('interrupted-after-guard') });
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(git(['status', '--porcelain'], item.worktreePath!)).toBe('');
    expect(await prepare()).toEqual(documents);
    installGuard();
    const stop = new AbortController();
    let built = '';
    await expect(landItemBranch(item, repo, 'main', 'Plan: shared', documents, commit => {
      built = commit; stop.abort(new Error('interrupted before promotion'));
    }, stop.signal)).rejects.toThrow('interrupted before promotion');
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(built).not.toBe('');
    const result = await landItemBranch({ ...item, landedCommit: built }, repo, 'main', 'Plan: shared');
    expect(result).toEqual({ status: 'landed', commit: built });
    const immutable = documents.find(doc => /_history_[a-f0-9]{64}_completed.md$/.test(doc.relativePath))!;
    expect(readFileSync(join(repo, immutable.relativePath), 'utf8')).toBe(immutable.content);
    expect(await retireActiveDocuments(item.documentPath, repo, 'main', null)).toEqual([]);
    expect(await retireActiveDocuments(item.documentPath, repo, 'main', null)).toEqual([]);
    expect(existsSync(item.documentPath)).toBe(false);
    expect(readFileSync(join(repo, history), 'utf8')).toBe(rootHistory);
    expect(existsSync(join(repo, 'docs/shared_livetest.md'))).toBe(true);
    expect(readFileSync(join(repo, '.git/history-guard-runs'), 'utf8')).toBe('guard-passed\n');
  });
});

describe('candidate history preservation boundaries', () => {
  it('refuses a candidate history symlink rather than publishing bytes outside its checkpoint', async () => {
    writeFileSync(join(repo, 'outside.txt'), 'outside candidate evidence\n');
    rmSync(join(item.worktreePath!, history));
    symlinkSync(join(repo, 'outside.txt'), join(item.worktreePath!, history));
    item = await service.checkpoint(item, 'linked history');
    await expect(prepare()).rejects.toThrow(/regular file/);
    expect(existsSync(join(repo, 'docs/shared_plan_completed.md'))).toBe(false);
  });

  it('preserves a newly added history as completed evidence without tracking its active name', async () => {
    // The queue branch may add history even when the base never tracked it.
    git(['rm', '--', history]);
    git(['commit', '--no-verify', '-qm', 'remove legacy history']);
    git(['merge', '--no-verify', '--no-edit', 'main'], item.worktreePath!);
    mkdirSync(join(item.worktreePath!, 'docs'), { recursive: true });
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    writeFileSync(join(repo, history), rootHistory);
    item = await service.checkpoint(item, 'new history');
    const documents = await prepare();
    const result = await landItemBranch(item, repo, 'main', 'Plan: shared', documents);
    expect(result.status).toBe('landed');
    expect(git(['ls-tree', 'main', '--', history])).toBe('');
    const immutable = documents.find(doc => /_history_[a-f0-9]{64}_completed.md$/.test(doc.relativePath))!;
    expect(readFileSync(join(repo, immutable.relativePath), 'utf8')).toContain(candidateHistory);
    expect(readFileSync(join(repo, history), 'utf8')).toBe(rootHistory);
  });

  it('keeps the shared base history when the candidate deleted its active copy', async () => {
    rmSync(join(item.worktreePath!, history));
    item = await service.checkpoint(item, 'removed history');
    const result = await landItemBranch(item, repo, 'main', 'Plan: shared', await prepare());
    expect(result.status).toBe('landed');
    expect(git(['show', `main:${history}`])).toBe(baseHistory.trim());
    expect(readFileSync(join(repo, history), 'utf8')).toBe(baseHistory);
  });

  it('refuses a candidate changed after its snapshot and retains the newer checkpoint', async () => {
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    item = await service.checkpoint(item, 'first');
    const documents = await prepare();
    writeFileSync(join(item.worktreePath!, history), `${candidateHistory}later candidate\n`);
    item = await service.checkpoint(item, 'second');
    const main = git(['rev-parse', 'main']);
    await expect(landItemBranch(item, repo, 'main', 'Plan: shared', documents)).rejects.toThrow('Candidate history changed');
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(readFileSync(join(item.worktreePath!, history), 'utf8')).toBe(`${candidateHistory}later candidate\n`);
    const rebuilt = await prepare();
    expect(rebuilt.find(doc => /_history_[a-f0-9]{64}_completed.md$/.test(doc.relativePath))?.relativePath)
      .not.toBe(documents.find(doc => /_history_[a-f0-9]{64}_completed.md$/.test(doc.relativePath))?.relativePath);
  });

  it('continues to refuse an unrelated active history alongside the snapshotted one', async () => {
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    writeFileSync(join(item.worktreePath!, 'unrelated_history.md'), 'not part of this closure\n');
    item = await service.checkpoint(item, 'active documents');
    const main = git(['rev-parse', 'main']);
    expect(await landItemBranch(item, repo, 'main', 'Plan: shared', await prepare()))
      .toEqual({ status: 'active-documents', paths: ['unrelated_history.md'] });
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(readFileSync(join(item.worktreePath!, 'unrelated_history.md'), 'utf8')).toBe('not part of this closure\n');
  });

  it('refuses to omit an active change when its completed evidence lost the candidate bytes', async () => {
    writeFileSync(join(item.worktreePath!, history), candidateHistory);
    item = await service.checkpoint(item, 'candidate');
    const documents = await prepare();
    const immutable = documents.find(doc => doc.historySource)!;
    immutable.content = 'incomplete evidence\n';
    const main = git(['rev-parse', 'main']);
    await expect(landItemBranch(item, repo, 'main', 'Plan: shared', documents)).rejects.toThrow('missing from its completed snapshot');
    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(readFileSync(join(item.worktreePath!, history), 'utf8')).toBe(candidateHistory);
  });
});
