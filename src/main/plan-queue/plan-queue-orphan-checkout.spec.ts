import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

vi.setConfig({ testTimeout: 30_000 });
let repo: string;
let item: PlanQueueItem;
let source: string;
let metadata: string;
let service: PlanQueueWorktreeService;
let flow: PlanQueueItemFlow;
let saves: PlanQueueItem[];
let onSave: (next: PlanQueueItem) => void;

function newFlow(): PlanQueueItemFlow {
  return new PlanQueueItemFlow({
    worktrees: service, getItem: () => item, getRun: () => ({ workspaceCwd: repo }),
    save: (next: PlanQueueItem) => { onSave(next); saves.push(next); item = next; return item; },
  } as unknown as PlanQueueFlowHost);
}

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function retainedPath(): string {
  const target = item.detail?.match(/Orphan checkout (?:retained at|recovery location:) (.+)\n/)?.[1];
  expect(target).toBeTruthy();
  return target!;
}

function breakMetadata(): void { rmSync(metadata, { recursive: true }); }
async function settleQueue(): Promise<void> { await GitWriteQueue.getInstance().enqueue('fixture-drain', async () => undefined); }

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-orphan-spec-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Fixture']);
  git(['config', 'user.email', 'queue@example.invalid']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '.']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
  source = join(repo, '.worktrees/queue/sample-abc123');
  git(['worktree', 'add', '-qb', 'queue/sample-abc123', source]);
  metadata = git(['rev-parse', '--absolute-git-dir'], source);
  writeFileSync(join(source, 'base.txt'), 'tracked edit\n');
  writeFileSync(join(source, 'untracked.txt'), 'retained work\n');
  item = {
    id: 'item-abc123', runId: 'run', documentPath: join(repo, 'docs/sample_plan.md'),
    state: 'parked', round: 0, erroredRounds: 0, landingRefusals: 0,
    branchName: 'queue/sample-abc123', worktreePath: source, baseCommit: git(['rev-parse', 'HEAD']),
    checkpointCommit: null, verifiedMainCommit: null, landedCommit: null,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null,
    parkReason: 'worktree-error', detail: 'Checkout interrupted', verdict: null, createdAt: 1, updatedAt: 1,
  };
  saves = [];
  onSave = () => undefined;
  const save = (next: PlanQueueItem) => { onSave(next); saves.push(next); item = next; return item; };
  service = new PlanQueueWorktreeService({ creator: {} as never, saveItem: save, skipInstall: true });
  flow = newFlow();
});

afterEach(async () => {
  await settleQueue();
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('explicit orphan Discard through the real queue flow', () => {
  it.each([false, true])('keeps files discoverable through supported Resume (overlapping Discard: %s) and later saves', async (overlap) => {
    breakMetadata();
    const db = new Database(':memory:') as unknown as SqliteDriver;
    try {
      runLoopMigrations(db);
      const store = new PlanQueueStore(db);
      store.upsertRun({ id: item.runId, parentInstanceId: 'parent', parentHistoryThreadId: null,
        kind: 'plans', workspaceCwd: repo, status: 'completed', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
        workerProvider: null, workerModel: null, relaxation: null, startedAt: 1, endedAt: 1 });
      store.upsertItem(item);
      const control = new PlanQueueCoordinator();
      Object.assign(control, { deps: { store, now: Date.now }, worktreeService: service,
        parents: { follow: (value: unknown) => value }, authorizeControl: () => 'James',
        reopen: () => undefined, requestPump: () => undefined });
      Object.assign(control, { flow: new PlanQueueItemFlow(control) });
      let resumed: Promise<void> | undefined;
      let scheduled = false;
      onSave = (next) => store.upsertItem(next);
      control.on('state-changed', () => {
        const next = store.getItem(item.id)!;
        if (overlap && !scheduled && next.detail?.includes('Orphan checkout recovery location:')) {
          scheduled = true;
          queueMicrotask(() => { resumed = control.control({ action: 'resume-item', itemId: item.id }); });
        }
      });
      await control.control({ action: 'discard-item', itemId: item.id });
      if (overlap) { expect(scheduled).toBe(true); expect(resumed).toBeDefined(); await resumed; }
      else await control.control({ action: 'resume-item', itemId: item.id });
      const after = store.getItem(item.id)!;
      const preserved = after.detail?.match(/Orphan checkout retained at (.+)\n/)?.[1];
      expect(preserved).toBeTruthy();
      expect(after.state).toBe('queued');
      expect(after.worktreePath).toBeNull();
      expect(after.branchName).toBeNull();
      expect(after.detail).toContain(`Orphan checkout retained at ${preserved}\n`);
      store.upsertItem({ ...after, state: 'verifying', detail: 'Replacement checker status' });
      expect(new PlanQueueStore(db).getItem(item.id)?.detail).toContain(`Orphan checkout retained at ${preserved}\n`);
      expect(readFileSync(join(preserved!, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    } finally { db.close(); }
  });

  it('preserves all content, saves its location before moving, and permits a fresh checkout', async () => {
    breakMetadata();
    const foreign = join(repo, '.worktrees/queue/foreign-other');
    git(['worktree', 'add', '-qb', 'queue/foreign-other', foreign]);
    writeFileSync(join(foreign, 'foreign.txt'), 'unrelated work\n');
    onSave = (next) => {
      if (next.detail?.includes('recovery location:')) {
        expect(existsSync(source)).toBe(true);
        expect(existsSync(next.detail.match(/recovery location: (.+)\n/)![1]!)).toBe(false);
      }
    };
    await flow.discard(item.id);

    const preserved = retainedPath();
    expect(readFileSync(join(preserved, 'base.txt'), 'utf8')).toBe('tracked edit\n');
    expect(readFileSync(join(preserved, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    expect(readFileSync(join(preserved, '.git'), 'utf8')).toContain(metadata);
    expect(item.worktreePath).toBeNull();
    expect(item.branchName).toBeNull();
    expect(git(['branch', '--list', 'queue/sample-abc123'])).toBe('');
    expect(readFileSync(join(foreign, 'foreign.txt'), 'utf8')).toBe('unrelated work\n');
    expect(git(['symbolic-ref', '--short', 'HEAD'], foreign)).toBe('queue/foreign-other');
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('base\n');
    await flow.discard(item.id); // A second explicit discard preserves the receipt.
    expect(retainedPath()).toBe(preserved);
    git(['worktree', 'add', '-qb', 'queue/retry', source]);
    expect(git(['symbolic-ref', '--short', 'HEAD'], source)).toBe('queue/retry');
  });

  it('diagnoses invalid Resume without changing files or the branch', async () => {
    breakMetadata();
    await expect(service.reattach(item, repo)).rejects.toThrow('explicitly approved Discard');
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    expect(git(['rev-parse', 'queue/sample-abc123'])).toBe(item.baseCommit);
  });

  it('diagnoses an existing copy with no gitfile without trying to overwrite it', async () => {
    breakMetadata();
    rmSync(join(source, '.git'));
    await expect(service.reattach(item, repo)).rejects.toThrow('saved queue checkout is invalid');
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
  });

  it('refuses Resume into another repository even when its branch and checkout path match', async () => {
    const foreign = join(repo, 'foreign');
    git(['init', '-q', '-b', 'main', foreign]);
    git(['config', 'user.name', 'Foreign Fixture'], foreign);
    git(['config', 'user.email', 'foreign@example.invalid'], foreign);
    writeFileSync(join(foreign, 'foreign.txt'), 'foreign base\n');
    git(['add', '.'], foreign);
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'foreign base'], foreign);
    const foreignCheckout = join(foreign, 'checkout');
    git(['worktree', 'add', '-qb', 'queue/sample-abc123', foreignCheckout], foreign);
    const foreignMetadata = git(['rev-parse', '--absolute-git-dir'], foreignCheckout);
    writeFileSync(join(foreignMetadata, 'gitdir'), `${join(source, '.git')}\n`);
    writeFileSync(join(source, '.git'), `gitdir: ${foreignMetadata}\n`);
    expect(git(['symbolic-ref', '--short', 'HEAD'], source)).toBe('queue/sample-abc123');
    await expect(service.reattach(item, repo)).rejects.toThrow('saved queue checkout is invalid');
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    expect(readFileSync(join(foreign, 'foreign.txt'), 'utf8')).toBe('foreign base\n');
  });

  it.each(['root', 'mismatched-pointer', 'symlink-copy', 'symlink-parent', 'symlink-gitfile', 'dangling-symlink'])(
    'refuses %s without deleting its branch or any retained data', async (scenario) => {
      breakMetadata();
      if (scenario === 'root') item = { ...item, worktreePath: repo };
      if (scenario === 'mismatched-pointer') writeFileSync(join(source, '.git'), `gitdir: ${join(repo, 'foreign/.git/worktrees/sample-abc123')}\n`);
      if (scenario === 'symlink-copy' || scenario === 'dangling-symlink') {
        renameSync(source, `${source}-preserved`);
        symlinkSync(scenario === 'symlink-copy' ? `${source}-preserved` : `${source}-absent`, source);
      }
      if (scenario === 'symlink-parent') {
        renameSync(dirname(source), `${dirname(source)}-preserved`);
        symlinkSync(`${dirname(source)}-preserved`, dirname(source));
      }
      if (scenario === 'symlink-gitfile') {
        renameSync(join(source, '.git'), join(source, 'pointer'));
        symlinkSync(join(source, 'pointer'), join(source, '.git'));
      }
      await expect(flow.discard(item.id)).rejects.toThrow();
      expect(git(['rev-parse', 'queue/sample-abc123'])).toBe(item.baseCommit);
      expect(item.branchName).toBe('queue/sample-abc123');
      expect(saves).toEqual([]);
      expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('base\n');
    },
  );

  it('refuses a valid registered checkout including uncommitted worker edits', async () => {
    await expect(flow.discard(item.id)).rejects.toThrow('metadata still exists');
    expect(git(['rev-parse', 'HEAD'], source)).toBe(item.baseCommit);
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
  });

  it('refuses an orphan branch that is now attached to another checkout', async () => {
    breakMetadata();
    const other = join(repo, '.worktrees/other');
    git(['worktree', 'add', '-q', other, 'queue/sample-abc123']);
    await expect(flow.discard(item.id)).rejects.toThrow('Git still registers');
    expect(git(['symbolic-ref', '--short', 'HEAD'], other)).toBe('queue/sample-abc123');
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
  });

  it('does not move content when the recovery receipt cannot be persisted', async () => {
    breakMetadata();
    onSave = () => { throw new Error('storage unavailable'); };
    await expect(flow.discard(item.id)).rejects.toThrow('storage unavailable');
    expect(existsSync(source)).toBe(true);
    expect(saves).toEqual([]);
    expect(git(['rev-parse', 'queue/sample-abc123'])).toBe(item.baseCommit);
  });

  it('retains truthful planned recovery evidence when the move fails, then retries', async () => {
    breakMetadata();
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error('move unavailable'));
    await expect(flow.discard(item.id)).rejects.toThrow('move unavailable');
    expect(item.worktreePath).toBe(source);
    expect(item.detail).toContain('recovery location:');
    expect(item.detail).not.toContain('retained at');
    expect(existsSync(source)).toBe(true);
    await settleQueue();
    flow = newFlow();
    await flow.discard(item.id);
    expect(readFileSync(join(retainedPath(), 'untracked.txt'), 'utf8')).toBe('retained work\n');
  });

  it('recovers after the move succeeded but the path-clear save failed', async () => {
    breakMetadata();
    onSave = (next) => { if (!next.worktreePath) throw new Error('save interrupted'); };
    await expect(flow.discard(item.id)).rejects.toThrow('save interrupted');
    const preserved = retainedPath();
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(join(preserved, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    onSave = () => undefined;
    await settleQueue();
    // A fresh flow represents restart recovery from the last durable row.
    flow = newFlow();
    await flow.discard(item.id);
    expect(item.worktreePath).toBeNull();
    expect(item.branchName).toBeNull();
    expect(retainedPath()).toBe(preserved);
  });

  it('never deletes a branch checked out elsewhere even when its saved path is absent', async () => {
    item = { ...item, worktreePath: null };
    await expect(flow.discard(item.id)).rejects.toThrow('still checked out');
    expect(git(['rev-parse', 'HEAD'], source)).toBe(item.baseCommit);
    expect(item.branchName).toBe('queue/sample-abc123');
  });

  it('rechecks ownership after saving the receipt and refuses a changed gitfile', async () => {
    breakMetadata();
    onSave = () => writeFileSync(join(source, '.git'), 'gitdir: /unrelated/checkout\n');
    await expect(flow.discard(item.id)).rejects.toThrow('changed during recovery');
    expect(existsSync(source)).toBe(true);
    expect(readFileSync(join(source, 'untracked.txt'), 'utf8')).toBe('retained work\n');
    expect(git(['rev-parse', 'queue/sample-abc123'])).toBe(item.baseCommit);
  });
});
