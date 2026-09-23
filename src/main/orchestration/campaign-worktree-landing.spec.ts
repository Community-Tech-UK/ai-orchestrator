/**
 * Campaign `isolation: 'worktree'` merge-back, against real Git repositories.
 *
 * Node loops are simulated (the loop starter is injected and terminal events
 * are delivered through `onLoopTerminal`); every worktree, harvest,
 * integration, promotion, and cleanup is real.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import {
  _resetWorktreeManagerForTesting,
  getWorktreeManager,
  type WorktreeManager,
} from '../workspace/git/worktree-manager';
import { CampaignCoordinator } from './campaign-coordinator';
import { CampaignStore } from './campaign-store';
import { runLoopMigrations } from './loop-schema';
import type { CampaignRun, CampaignSpec } from './campaign.types';
import type { LoopStatus } from '../../shared/types/loop.types';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { prepareLoopControl } from './loop-control';
import { loopExecutionCwd, loopStateCwd, type LoopCwdConfig } from './loop-cwd';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const execFileAsync = promisify(execFile);
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' });
  return stdout.trim();
}

let repo: string;
let manager: WorktreeManager;

beforeEach(async () => {
  GitWriteQueue._resetForTesting();
  _resetWorktreeManagerForTesting();
  manager = getWorktreeManager();
  manager.configure({ installDeps: false });
  repo = mkdtempSync(join(tmpdir(), 'campaign-landing-'));
  await git(['init', '-q', '-b', 'main'], repo);
  await git(['config', 'user.email', 'test@example.com'], repo);
  await git(['config', 'user.name', 'Test'], repo);
  await git(['config', 'commit.gpgsign', 'false'], repo);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n.mise.local.toml\n');
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  await git(['add', '-A'], repo);
  await git(['commit', '-q', '-m', 'base'], repo);
});

afterEach(() => {
  _resetWorktreeManagerForTesting();
  rmSync(repo, { recursive: true, force: true });
});

interface Internals {
  store: CampaignStore | null;
  onLoopTerminal: (loopRunId: string, status: LoopStatus) => Promise<void>;
}

function buildSpec(id: string, overrides: Partial<CampaignSpec> = {}): CampaignSpec {
  const node = (nodeId: string, dependsOn: string[] = []) => ({
    id: nodeId,
    loopConfig: { initialPrompt: `do ${nodeId}`, workspaceCwd: repo, completion: { verifyCommand: 'true' } },
    dependsOn,
  });
  return {
    id,
    title: 'Landing',
    nodes: [node('a')],
    edges: [],
    policy: { onNodeNeedsReview: 'pause-campaign', maxParallel: 2, isolation: 'worktree' },
    createdAt: 1,
    ...overrides,
  };
}

function specWithNodes(id: string, nodeIds: string[], edges: CampaignSpec['edges'] = [], isolated = true): CampaignSpec {
  return {
    ...buildSpec(id),
    nodes: nodeIds.map((nodeId) => ({
      id: nodeId,
      loopConfig: { initialPrompt: `do ${nodeId}`, workspaceCwd: repo, completion: { verifyCommand: 'true' } },
      dependsOn: [],
    })),
    edges,
    policy: {
      onNodeNeedsReview: 'pause-campaign',
      maxParallel: 2,
      ...(isolated ? { isolation: 'worktree' as const } : {}),
    },
  };
}

function makeCoordinator(store: CampaignStore | null = null) {
  const coordinator = new CampaignCoordinator();
  const internals = coordinator as unknown as Internals;
  internals.store = store;
  const loopStarter = vi.fn(async (chatId: string, _config: unknown) => ({ id: `loop-${chatId.split(':').at(-1)}` }));
  coordinator.setLoopStarterForTesting(loopStarter);
  const awaitLoopSettled = vi.fn(async () => undefined);
  coordinator.setWorktreeLandingDepsForTesting({
    getManager: () => manager,
    awaitLoopSettled,
    readLoopWorktreeLifecycle: () => undefined,
  });
  return { coordinator, internals, loopStarter, awaitLoopSettled };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await flush();
  }
}

async function startAndWait(coordinator: CampaignCoordinator, spec: CampaignSpec, running: string[]): Promise<CampaignRun> {
  const run = await coordinator.startCampaign(spec);
  await waitUntil(() => running.every((id) => run.nodeRuns.get(id)?.status === 'running'));
  return run;
}

function nodeWorktree(run: CampaignRun, nodeId: string): { path: string; branch: string } {
  const node = run.nodeRuns.get(nodeId)!;
  return { path: node.worktreePath!, branch: node.worktreeLifecycle!.sessionBranch };
}

async function branchExists(branch: string): Promise<boolean> {
  return (await git(['branch', '--list', branch], repo)) !== '';
}

describe('campaign worktree landing', () => {
  it('merges a successful node back into the repository and removes its worktree and branch', async () => {
    const { coordinator, internals } = makeCoordinator();
    const run = await startAndWait(coordinator, buildSpec('camp-land'), ['a']);
    const wt = nodeWorktree(run, 'a');
    expect(existsSync(wt.path)).toBe(true);
    writeFileSync(join(wt.path, 'feature-a.txt'), 'from node a\n');

    await internals.onLoopTerminal('loop-a', 'completed');

    expect(readFileSync(join(repo, 'feature-a.txt'), 'utf-8')).toBe('from node a\n');
    expect(await git(['status', '--porcelain'], repo)).toBe('');
    expect(existsSync(wt.path)).toBe(false);
    expect(await branchExists(wt.branch)).toBe(false);
    expect(manager.getAllSessions()).toHaveLength(0);
    const node = run.nodeRuns.get('a')!;
    expect(node.worktreeLifecycle?.phase).toBe('cleaned');
    expect(node.worktreePath).toBeUndefined();
    expect(node.status).toBe('completed');
    expect(run.status).toBe('completed');
  });

  it('keeps the branch, records the block, and pauses the campaign when the merge conflicts', async () => {
    const { coordinator, internals, loopStarter } = makeCoordinator();
    const run = await startAndWait(
      coordinator,
      specWithNodes('camp-conflict', ['a', 'b'], [{ from: 'a', to: 'b' }]),
      ['a'],
    );
    const wt = nodeWorktree(run, 'a');
    writeFileSync(join(wt.path, 'base.txt'), 'node change\n');
    writeFileSync(join(repo, 'base.txt'), 'root change\n');
    await git(['commit', '-q', '-am', 'root moved on'], repo);

    await internals.onLoopTerminal('loop-a', 'completed');

    const node = run.nodeRuns.get('a')!;
    expect(node.status).toBe('completed');
    expect(node.worktreeLifecycle?.phase).toBe('blocked');
    expect(node.worktreeLifecycle?.lastError).toContain('integration failed');
    expect(await branchExists(wt.branch)).toBe(true);
    expect(await git(['show', `${wt.branch}:base.txt`], repo)).toBe('node change');
    expect(readFileSync(join(repo, 'base.txt'), 'utf-8')).toBe('root change\n');
    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('could not be merged back');
    expect(run.pausedReason).toContain(wt.branch);
    expect(run.nodeRuns.get('b')?.status).toBe('pending');
    expect(loopStarter).toHaveBeenCalledTimes(1);
  });

  it('leaves non-worktree campaigns untouched', async () => {
    const { coordinator, internals, awaitLoopSettled } = makeCoordinator();
    const getManager = vi.fn(() => {
      throw new Error('non-worktree campaigns must not touch the worktree manager');
    });
    coordinator.setWorktreeLandingDepsForTesting({ getManager });
    const run = await startAndWait(coordinator, specWithNodes('camp-plain', ['a'], [], false), ['a']);

    await internals.onLoopTerminal('loop-a', 'completed');

    expect(run.nodeRuns.get('a')?.worktreeLifecycle).toBeUndefined();
    expect(run.nodeRuns.get('a')?.status).toBe('completed');
    expect(run.status).toBe('completed');
    expect(getManager).not.toHaveBeenCalled();
    expect(awaitLoopSettled).not.toHaveBeenCalled();
    expect(await git(['worktree', 'list', '--porcelain'], repo)).not.toContain('.worktrees');
  });

  it.each([
    ['failed', 'failed', 'paused'],
    ['cancelled', 'operator-halted', 'halted'],
  ] as const)('preserves a %s node on its branch without merging it', async (loopStatus, nodeStatus, campaignStatus) => {
    const { coordinator, internals } = makeCoordinator();
    const run = await startAndWait(coordinator, buildSpec(`camp-${loopStatus}`), ['a']);
    const wt = nodeWorktree(run, 'a');
    writeFileSync(join(wt.path, 'partial.txt'), 'unfinished\n');

    await internals.onLoopTerminal('loop-a', loopStatus);

    expect(existsSync(join(repo, 'partial.txt'))).toBe(false);
    expect(await branchExists(wt.branch)).toBe(true);
    expect(await git(['show', `${wt.branch}:partial.txt`], repo)).toBe('unfinished');
    expect(existsSync(wt.path)).toBe(false);
    expect(run.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('cleaned');
    expect(run.nodeRuns.get('a')?.status).toBe(nodeStatus);
    expect(run.status).toBe(campaignStatus);
  });

  it('lands two nodes that finish together one at a time', async () => {
    const { coordinator, internals } = makeCoordinator();
    const run = await startAndWait(coordinator, specWithNodes('camp-serial', ['a', 'b']), ['a', 'b']);
    const a = nodeWorktree(run, 'a');
    const b = nodeWorktree(run, 'b');
    writeFileSync(join(a.path, 'feature-a.txt'), 'a\n');
    writeFileSync(join(b.path, 'feature-b.txt'), 'b\n');

    const events: string[] = [];
    const record = <K extends 'harvestWorktree' | 'promoteWorktreeIntegration'>(method: K) => {
      const original = manager[method].bind(manager) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(manager, method).mockImplementation((async (...args: unknown[]) => {
        events.push(`${method}:start:${String(args[0])}`);
        const result = await original(...args);
        events.push(`${method}:end:${String(args[0])}`);
        return result;
      }) as never);
    };
    record('harvestWorktree');
    record('promoteWorktreeIntegration');

    await Promise.all([
      internals.onLoopTerminal('loop-a', 'completed'),
      internals.onLoopTerminal('loop-b', 'completed'),
    ]);

    expect(events).toHaveLength(8);
    const first = events[0].split(':').at(-1);
    const firstLanding = events.slice(0, 4);
    expect(firstLanding.every((event) => event.endsWith(`:${first}`))).toBe(true);
    expect(firstLanding.at(-1)).toBe(`promoteWorktreeIntegration:end:${first}`);
    expect(readFileSync(join(repo, 'feature-a.txt'), 'utf-8')).toBe('a\n');
    expect(readFileSync(join(repo, 'feature-b.txt'), 'utf-8')).toBe('b\n');
    expect(run.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('cleaned');
    expect(run.nodeRuns.get('b')?.worktreeLifecycle?.phase).toBe('cleaned');
    expect(await branchExists(a.branch)).toBe(false);
    expect(await branchExists(b.branch)).toBe(false);
    expect(run.status).toBe('completed');
  });

  it('does not harvest until the node loop has settled its own landing', async () => {
    const { coordinator, internals } = makeCoordinator();
    let settle!: () => void;
    const awaitLoopSettled = vi.fn(() => new Promise<void>((resolve) => { settle = resolve; }));
    coordinator.setWorktreeLandingDepsForTesting({ awaitLoopSettled });
    const harvest = vi.spyOn(manager, 'harvestWorktree');
    const run = await startAndWait(coordinator, buildSpec('camp-settle'), ['a']);
    writeFileSync(join(nodeWorktree(run, 'a').path, 'feature-a.txt'), 'a\n');

    const terminal = internals.onLoopTerminal('loop-a', 'completed');
    await waitUntil(() => awaitLoopSettled.mock.calls.length > 0);
    await flush();
    expect(awaitLoopSettled).toHaveBeenCalledWith('loop-a');
    expect(harvest).not.toHaveBeenCalled();
    expect(run.nodeRuns.get('a')?.status).toBe('running');

    settle();
    await terminal;
    expect(harvest).toHaveBeenCalledTimes(1);
    expect(existsSync(join(repo, 'feature-a.txt'))).toBe(true);
  });

  it('finishes an interrupted landing after an app restart', async () => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
    runLoopMigrations(db);
    const store = new CampaignStore(db);
    const first = makeCoordinator(store);
    const run = await startAndWait(first.coordinator, buildSpec('camp-restart'), ['a']);
    const wt = nodeWorktree(run, 'a');
    writeFileSync(join(wt.path, 'feature-a.txt'), 'survived restart\n');

    // Restart: the WorktreeManager session map is gone; only the DB remains.
    _resetWorktreeManagerForTesting();
    manager = getWorktreeManager();
    const second = makeCoordinator(store);
    second.coordinator.setLoopStatusReaderForTesting(() => ({ status: 'completed', endedAt: Date.now() }));
    await second.coordinator.recoverInterruptedCampaigns();

    expect(readFileSync(join(repo, 'feature-a.txt'), 'utf-8')).toBe('survived restart\n');
    expect(existsSync(wt.path)).toBe(false);
    expect(await branchExists(wt.branch)).toBe(false);
    const persisted = store.getCampaign('camp-restart')!;
    expect(persisted.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('cleaned');
    expect(persisted.nodeRuns.get('a')?.worktreePath).toBeUndefined();
    expect(persisted.nodeRuns.get('a')?.status).toBe('completed');
    expect(persisted.status).toBe('completed');
  });

  it('releases the worktree of a node whose loop failed to start', async () => {
    const { coordinator, loopStarter } = makeCoordinator();
    loopStarter.mockRejectedValue(new Error('startup failed'));
    const run = await coordinator.startCampaign(buildSpec('camp-start-fail'));
    await waitUntil(() => run.status === 'paused');

    const node = run.nodeRuns.get('a')!;
    expect(node.status).toBe('failed');
    expect(node.worktreeLifecycle?.phase).toBe('cleaned');
    expect(node.worktreePath).toBeUndefined();
    expect(await git(['worktree', 'list', '--porcelain'], repo)).not.toContain('.worktrees');
    expect(manager.getAllSessions()).toHaveLength(0);
  });
});

describe('campaign worktree landing — isolation boundaries', () => {
  it('keeps loop state at the repository root so none of it reaches the base branch', async () => {
    const { coordinator, internals, loopStarter } = makeCoordinator();
    // Write state exactly where the loop coordinator would: the state cwd.
    loopStarter.mockImplementation(async (chatId: string, received: unknown) => {
      const id = `loop-${chatId.split(':').at(-1)}`;
      const config = received as LoopCwdConfig;
      await prepareLoopControl(loopStateCwd(config), id);
      const paths = resolveLoopArtifactPaths(loopStateCwd(config), id);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(paths.stage, 'IMPLEMENT\n');
      writeFileSync(join(loopExecutionCwd(config), 'feature-a.txt'), 'work product\n');
      return { id };
    });
    const gitignoreBefore = await git(['show', 'main:.gitignore'], repo);
    const run = await startAndWait(coordinator, buildSpec('camp-state'), ['a']);
    const config = loopStarter.mock.calls[0][1] as LoopCwdConfig;
    expect(config.workspaceCwd).toBe(repo);
    expect(config.executionCwd).toBe(nodeWorktree(run, 'a').path);

    await internals.onLoopTerminal('loop-a', 'completed');

    expect(run.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('cleaned');
    expect(await git(['show', 'main:feature-a.txt'], repo)).toBe('work product');
    const landed = await git(['ls-tree', '-r', '--name-only', 'main'], repo);
    expect(landed).not.toContain('.aio-loop');
    expect(await git(['show', 'main:.gitignore'], repo)).toBe(gitignoreBefore);
    expect(existsSync(resolveLoopArtifactPaths(repo, 'loop-a').stage)).toBe(true);
  });

  it('refuses to land, and deletes nothing, when the campaign worktree holds a nested worktree', async () => {
    const { coordinator, internals } = makeCoordinator();
    const run = await startAndWait(coordinator, buildSpec('camp-nested'), ['a']);
    const wt = nodeWorktree(run, 'a');
    writeFileSync(join(wt.path, 'feature-a.txt'), 'a\n');
    const nested = join(wt.path, '.worktrees', 'task-nested');
    await git(['worktree', 'add', '-q', '-b', 'task-nested', nested], wt.path);
    writeFileSync(join(nested, 'uncommitted.txt'), 'only copy\n');

    await internals.onLoopTerminal('loop-a', 'completed');

    const lifecycle = run.nodeRuns.get('a')?.worktreeLifecycle;
    expect(lifecycle?.phase).toBe('blocked');
    expect(lifecycle?.lastError).toContain('.worktrees/');
    expect(readFileSync(join(nested, 'uncommitted.txt'), 'utf-8')).toBe('only copy\n');
    expect(existsSync(join(wt.path, 'feature-a.txt'))).toBe(true);
    expect(await git(['rev-parse', wt.branch], repo)).toBe(await git(['rev-parse', 'main'], repo));
    expect(existsSync(join(repo, 'feature-a.txt'))).toBe(false);
    expect(run.status).toBe('paused');
    expect(run.pausedReason).toContain('could not be merged back');
  });

  it('refuses to land while the node loop still owns an unfinished worktree of its own', async () => {
    const { coordinator, internals } = makeCoordinator();
    coordinator.setWorktreeLandingDepsForTesting({
      readLoopWorktreeLifecycle: () => ({
        managedByAio: true, phase: 'blocked', baseBranch: 'x', sessionBranch: 'y', updatedAt: 1,
      }),
    });
    const run = await startAndWait(coordinator, buildSpec('camp-loop-wt'), ['a']);
    const wt = nodeWorktree(run, 'a');
    writeFileSync(join(wt.path, 'feature-a.txt'), 'a\n');

    await internals.onLoopTerminal('loop-a', 'completed');

    expect(run.nodeRuns.get('a')?.worktreeLifecycle?.lastError).toContain("node loop's own worktree");
    expect(existsSync(join(wt.path, 'feature-a.txt'))).toBe(true);
    expect(existsSync(join(repo, 'feature-a.txt'))).toBe(false);
  });

  it('applies the same refusal to boot recovery instead of harvesting a nested worktree', async () => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrations(db);
    const store = new CampaignStore(db);
    const first = makeCoordinator(store);
    const run = await startAndWait(first.coordinator, buildSpec('camp-nested-boot'), ['a']);
    const wt = nodeWorktree(run, 'a');
    const nested = join(wt.path, '.worktrees', 'task-nested');
    await git(['worktree', 'add', '-q', '-b', 'task-nested', nested], wt.path);
    writeFileSync(join(nested, 'uncommitted.txt'), 'only copy\n');

    _resetWorktreeManagerForTesting();
    manager = getWorktreeManager();
    const second = makeCoordinator(store);
    second.coordinator.setLoopStatusReaderForTesting(() => ({ status: 'completed', endedAt: Date.now() }));
    await second.coordinator.recoverInterruptedCampaigns();

    expect(store.getCampaign('camp-nested-boot')!.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('blocked');
    expect(readFileSync(join(nested, 'uncommitted.txt'), 'utf-8')).toBe('only copy\n');
  });

  it('halts (not pauses) a needs-review node with a blocked landing under the halt policy', async () => {
    const { coordinator, internals } = makeCoordinator();
    const spec = buildSpec('camp-halt-policy');
    spec.policy = { ...spec.policy, onNodeNeedsReview: 'halt' };
    const run = await startAndWait(coordinator, spec, ['a']);
    writeFileSync(join(nodeWorktree(run, 'a').path, 'base.txt'), 'node change\n');
    writeFileSync(join(repo, 'base.txt'), 'root change\n');
    await git(['commit', '-q', '-am', 'root moved on'], repo);

    await internals.onLoopTerminal('loop-a', 'completed-needs-review');

    expect(run.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('blocked');
    expect(run.status).toBe('halted');
  });

  it('lands a halted campaign node whose loop ends after an app restart', async () => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrations(db);
    const store = new CampaignStore(db);
    const first = makeCoordinator(store);
    const run = await startAndWait(first.coordinator, buildSpec('camp-halted-restart'), ['a']);
    const wt = nodeWorktree(run, 'a');
    first.coordinator.haltCampaignByOperator(run.id);

    _resetWorktreeManagerForTesting();
    manager = getWorktreeManager();
    const second = makeCoordinator(store);
    second.coordinator.setLoopStatusReaderForTesting(() => ({ status: 'running', endedAt: null }));
    await second.coordinator.recoverInterruptedCampaigns();
    writeFileSync(join(wt.path, 'feature-a.txt'), 'finished after halt\n');

    await second.internals.onLoopTerminal('loop-a', 'completed');

    expect(await git(['show', 'main:feature-a.txt'], repo)).toBe('finished after halt');
    expect(existsSync(wt.path)).toBe(false);
    const persisted = store.getCampaign('camp-halted-restart')!;
    expect(persisted.status).toBe('halted');
    expect(persisted.nodeRuns.get('a')?.worktreeLifecycle?.phase).toBe('cleaned');
  });
});
