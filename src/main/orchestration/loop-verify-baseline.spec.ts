import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startVerifyBaseline } from './loop-verify-baseline';
import { captureLoopRepoBaseline } from './loop-repo-state';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { classifyVerifyAgainstBaseline } from './loop-verify-baseline-compare';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup(dirty = false, git = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-baseline-')); roots.push(root);
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  if (git) {
    execFileSync('git', ['init', '-q', repo]);
    await fs.writeFile(path.join(repo, 'file.ts'), 'before');
    execFileSync('git', ['add', '.'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed'], { cwd: repo });
    if (dirty) await fs.writeFile(path.join(repo, 'file.ts'), 'dirty');
  }
  const config = defaultLoopConfig(repo, 'implement'); config.completion.verifyCommand = 'npm test';
  const state = { id: 'baseline-spec', config, repoBaseline: captureLoopRepoBaseline(repo), pendingInterventions: [] } as unknown as LoopState;
  return { root, repo, state };
}
describe('starting verification copy', () => {
  it('checks committed bytes outside the repository and removes its copy', async () => {
    const { root, repo, state } = await setup(true);
    const runVerify = vi.fn(async (config: import('../../shared/types/loop.types').LoopConfig) => {
      expect(config.executionCwd!.startsWith(repo + path.sep)).toBe(false);
      expect(await fs.readFile(path.join(config.executionCwd!, 'file.ts'), 'utf8')).toBe('before');
      return { status: 'failed' as const, failureKind: 'command' as const, exitCode: 1, durationMs: 1, output: 'file.ts(1,1): error TS2322: wrong' };
    });
    await startVerifyBaseline(state, { dataDir: root, runVerify, emit: vi.fn(), isActive: () => true, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md', provision: async () => ({ method: 'skipped', symlinks: [], nativeAbi: [] }) });
    expect(state.preflight?.baseline).toMatchObject({ status: 'recorded', scope: 'committed-head', failingCount: 1 });
    expect(state.pendingInterventions[0].message).toContain('under Information');
    await expect(fs.access(path.join(root, 'loop-baselines', state.id))).rejects.toThrow();
  });
  it('removes the copy even if the verifier throws', async () => {
    const { root, state } = await setup();
    await startVerifyBaseline(state, { dataDir: root, runVerify: async () => { throw new Error('cancelled'); }, emit: vi.fn(), isActive: () => true, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md', provision: async () => ({ method: 'skipped', symlinks: [], nativeAbi: [] }) });
    expect(state.preflight?.baseline?.status).toBe('unknown');
    await expect(fs.access(path.join(root, 'loop-baselines', state.id))).rejects.toThrow();
  });
  it('records non-Git as unknown without running verification', async () => {
    const { root, state } = await setup(false, false); const runVerify = vi.fn();
    await startVerifyBaseline(state, { dataDir: root, runVerify, emit: vi.fn(), isActive: () => true, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md' });
    expect(runVerify).not.toHaveBeenCalled(); expect(state.preflight?.baseline?.status).toBe('unknown');
  });
});

it('cleans up a cancelled starting copy without publishing late evidence', async () => {
  const { root, state } = await setup(); let active = true;
  const emit = vi.fn();
  await startVerifyBaseline(state, { dataDir: root, emit, isActive: () => active, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md',
    provision: async () => ({ method: 'skipped', symlinks: [], nativeAbi: [] }),
    runVerify: async () => { active = false; return { status: 'failed', output: 'cancelled', durationMs: 1, exitCode: null, failureKind: 'cancelled' }; },
  });
  expect(state.preflight).toBeUndefined(); expect(emit).not.toHaveBeenCalled();
  await expect(fs.access(path.join(root, 'loop-baselines', state.id))).rejects.toThrow();
});

it('keeps nested workspace verification in the matching starting subdirectory', async () => {
  const { root, repo, state } = await setup();
  const nested = path.join(repo, 'app'); await fs.mkdir(nested); await fs.writeFile(path.join(nested, 'package.json'), '{}');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested'], { cwd: repo });
  state.config.workspaceCwd = nested; state.repoBaseline = captureLoopRepoBaseline(nested);
  await startVerifyBaseline(state, { dataDir: root, emit: vi.fn(), isActive: () => true, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md',
    provision: async () => ({ method: 'skipped', symlinks: [], nativeAbi: [] }),
    runVerify: async config => {
      expect(config.executionCwd).toBe(path.join(root, 'loop-baselines', state.id, 'app'));
      expect(await fs.readFile(path.join(config.executionCwd!, 'package.json'), 'utf8')).toBe('{}');
      return { status: 'passed', output: '', durationMs: 1 };
    },
  });
  expect(state.preflight?.baseline?.status).toBe('recorded');
});

it('records the nested diagnostic prefix so HEAD cannot excuse dirty bytes it never checked', async () => {
  const { root, repo, state } = await setup();
  const nested = path.join(repo, 'app'); await fs.mkdir(path.join(nested, 'src'), { recursive: true });
  const source = path.join(nested, 'src/a.ts'); await fs.writeFile(source, 'before');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Spec', '-c', 'user.email=spec@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'nested source'], { cwd: repo });
  await fs.writeFile(source, 'dirty'); state.config.workspaceCwd = nested; state.repoBaseline = captureLoopRepoBaseline(nested);
  const output = '> project@1.0.0 typecheck\nsrc/a.ts(1,2): error TS2322: wrong type';
  await startVerifyBaseline(state, { dataDir: root, emit: vi.fn(), isActive: () => true, informationHeading: 'For information', outstandingPath: 'OUTSTANDING.md',
    provision: async () => ({ method: 'skipped', symlinks: [], nativeAbi: [] }), runVerify: async config => {
      expect(await fs.readFile(path.join(config.executionCwd!, 'src/a.ts'), 'utf8')).toBe('before');
      return { status: 'failed', output, durationMs: 1, exitCode: 1, failureKind: 'command' };
    } });
  expect(classifyVerifyAgainstBaseline(state, { status: 'failed', output, failureKind: 'command' })).toMatchObject({ kind: 'new-failures' });
});

it('reconciles only registered inactive baseline copies on boot', async () => {
  const { cleanupStaleVerifyBaselines } = await import('./loop-verify-baseline');
  const { root, repo } = await setup(); const base = path.join(root, 'loop-baselines'); await fs.mkdir(base);
  const stale = path.join(base, 'stale'); const active = path.join(base, 'active'); const foreign = path.join(base, 'unregistered');
  for (const dir of [stale, active]) execFileSync('git', ['worktree', 'add', '--detach', dir, 'HEAD'], { cwd: repo, stdio: 'pipe' });
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'human.txt'), 'keep');
  await cleanupStaleVerifyBaselines(root, [], new Set(['active']));
  await expect(fs.access(stale)).rejects.toThrow();
  await expect(fs.access(active)).resolves.toBeUndefined();
  expect(await fs.readFile(path.join(foreign, 'human.txt'), 'utf8')).toBe('keep');
});

it('refuses dependencies whose symlinks would let baseline commands write outside the copy', async () => {
  const { root, repo, state } = await setup(); const runVerify = vi.fn();
  await startVerifyBaseline(state, { dataDir: root, runVerify, emit: vi.fn(), isActive: () => true, informationHeading: 'Information', outstandingPath: 'OUTSTANDING.md',
    provision: async (_repo, dir) => {
      await fs.mkdir(path.join(dir, 'node_modules'));
      await fs.symlink(repo, path.join(dir, 'node_modules', 'linked-project'));
      return { method: 'cloned', symlinks: [], nativeAbi: [] };
    },
  });
  expect(runVerify).not.toHaveBeenCalled();
  expect(state.preflight?.baseline).toMatchObject({ status: 'unknown', reason: expect.stringContaining('outside') });
});
