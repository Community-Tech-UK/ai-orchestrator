import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configForLoopExecutionCwd,
  isLoopWorkspaceIsolated,
  loopExecutionCwd,
  loopStateCwd,
} from './loop-cwd';
import { CompletedFileWatcher, LoopCompletionDetector } from './loop-completion-detector';
import { blindReviewerWorkspaceStartError } from './loop-coordinator-state-helpers';
import { LoopStageMachine } from './loop-stage-machine';
import { recordCwdVerifyCommand } from './loop-test-commands';
import {
  clampPingPongReviewerTimeoutSeconds,
  defaultCrossModelReviewConfig,
  defaultLoopConfig,
  defaultPingPongConfig,
  PINGPONG_DEFAULT_REVIEWER_TIMEOUT_SECONDS,
} from '../../shared/types/loop.types';

let base: string;
let repoRoot: string;
let worktree: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cwd-test-'));
  const rawWorktree = path.join(base, 'repo', '.worktrees', 'session');
  fs.mkdirSync(rawWorktree, { recursive: true });
  // realpath AFTER creation: the spawned command reports a resolved cwd
  // (/private/var/... on macOS), so the expectation has to be resolved too.
  repoRoot = fs.realpathSync(path.join(base, 'repo'));
  worktree = fs.realpathSync(rawWorktree);
});

afterEach(() => {
  try {
    fs.rmSync(base, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

describe('loopExecutionCwd / loopStateCwd', () => {
  it('returns the worktree for execution and the repo root for state when isolated', () => {
    const config = { workspaceCwd: '/repo', executionCwd: '/repo/.worktrees/s1' };
    expect(loopExecutionCwd(config)).toBe('/repo/.worktrees/s1');
    expect(loopStateCwd(config)).toBe('/repo');
    expect(isLoopWorkspaceIsolated(config)).toBe(true);
  });

  it('collapses to the repo root when isolation is off', () => {
    const config = { workspaceCwd: '/repo', executionCwd: undefined };
    expect(loopExecutionCwd(config)).toBe('/repo');
    expect(loopStateCwd(config)).toBe('/repo');
    expect(isLoopWorkspaceIsolated(config)).toBe(false);
  });

  it('treats a blank or identical executionCwd as no isolation', () => {
    expect(loopExecutionCwd({ workspaceCwd: '/repo', executionCwd: '   ' })).toBe('/repo');
    expect(isLoopWorkspaceIsolated({ workspaceCwd: '/repo', executionCwd: '  ' })).toBe(false);
    expect(isLoopWorkspaceIsolated({ workspaceCwd: '/repo', executionCwd: '/repo' })).toBe(false);
  });

  it('configForLoopExecutionCwd rewrites workspaceCwd only when isolated', () => {
    const isolated = { workspaceCwd: '/repo', executionCwd: '/repo/.worktrees/s1', other: 1 };
    expect(configForLoopExecutionCwd(isolated).workspaceCwd).toBe('/repo/.worktrees/s1');
    expect(configForLoopExecutionCwd(isolated).other).toBe(1);

    const plain = { workspaceCwd: '/repo', executionCwd: undefined };
    expect(configForLoopExecutionCwd(plain)).toBe(plain);
  });
});

/**
 * The regression that matters. Before 2026-09-03 the completion gate spawned
 * the verify command in `workspaceCwd`, so under isolation it graded the repo
 * root — i.e. whatever other sessions had left uncommitted — instead of the
 * worktree the agent actually edited. Every otherwise-approved completion was
 * rejected, and no loop completed cleanly for over two months.
 *
 * No previous test asserted the spawn cwd, which is exactly why it shipped.
 */
describe('verify commands run in the execution cwd', () => {
  it('runVerify spawns in the worktree, not the repo root', async () => {
    const out = path.join(repoRoot, 'verify-cwd.txt');
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.executionCwd = worktree;
    config.isolateLoopWorkspaces = true;
    config.completion.verifyCommand = recordCwdVerifyCommand(out);
    config.completion.verifyTimeoutMs = 20_000;

    const result = await new LoopCompletionDetector().runVerify(config);

    expect(result.status).toBe('passed');
    expect(fs.readFileSync(out, 'utf8')).toBe(worktree);
  });

  it('runQuickVerify spawns in the worktree, not the repo root', async () => {
    const out = path.join(repoRoot, 'quick-verify-cwd.txt');
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.executionCwd = worktree;
    config.isolateLoopWorkspaces = true;
    config.completion.quickVerifyCommand = recordCwdVerifyCommand(out);
    config.completion.quickVerifyTimeoutMs = 20_000;

    const result = await new LoopCompletionDetector().runQuickVerify(config);

    expect(result.status).toBe('passed');
    expect(fs.readFileSync(out, 'utf8')).toBe(worktree);
  });

  it('still spawns in the repo root when isolation is off', async () => {
    const out = path.join(repoRoot, 'verify-cwd-plain.txt');
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.completion.verifyCommand = recordCwdVerifyCommand(out);
    config.completion.verifyTimeoutMs = 20_000;

    const result = await new LoopCompletionDetector().runVerify(config);

    expect(result.status).toBe('passed');
    expect(fs.readFileSync(out, 'utf8')).toBe(repoRoot);
  });
});

describe('plan-file completion detection follows the execution cwd', () => {
  function observePlanRename(planRenamedIn: string): Promise<readonly { id: string }[]> {
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.executionCwd = worktree;
    config.isolateLoopWorkspaces = true;
    config.planFile = 'plan.md';
    fs.writeFileSync(path.join(planRenamedIn, 'plan_completed.md'), '# done');

    return new LoopCompletionDetector().observe({
      iteration: { stage: 'IMPLEMENT', filesChanged: [], completionSignalsFired: [] },
      config,
      state: {
        id: 'loop-1',
        startedAt: Date.now() - 60_000,
        completedFileRenameObserved: false,
        planChecklistFullyCheckedAtStart: false,
      },
    } as unknown as Parameters<LoopCompletionDetector['observe']>[0]);
  }

  it('sees a plan renamed inside the worktree', async () => {
    const observed = await observePlanRename(worktree);
    expect(observed.some((e) => e.id === 'completed-rename')).toBe(true);
  });

  it('does not fire on a stale completed plan sitting in the repo root', async () => {
    const observed = await observePlanRename(repoRoot);
    expect(observed.some((e) => e.id === 'completed-rename')).toBe(false);
  });
});

/**
 * The live watcher is the fast path for the completed-plan-rename signal; the
 * per-iteration poll is only the fallback. Its watch root doubles as the
 * containment filter for the extra plan directories, so if it is the repo root
 * while the plan directory sits outside that tree, the real directory is
 * silently dropped and the rename is never seen in real time.
 *
 * SCOPE: this pins the CLASS's behaviour given a correct root. The defect
 * itself lived at the two `loop-coordinator.ts` construction sites, which this
 * test does not invoke — reverting them would leave it green. That regression
 * is held by `scripts/check-loop-cwd-discipline.js` instead (the
 * `state-cwd-positional` rule matches `new CompletedFileWatcher(` followed by
 * `config.workspaceCwd`, across lines), so a revert fails
 * `npm run verify:architecture`.
 */
describe('CompletedFileWatcher watches the execution cwd', () => {
  it('observes a plan rename in a worktree that is NOT nested under the repo root', async () => {
    const external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cwd-external-')));
    const plansDir = path.join(external, 'docs', 'plans');
    fs.mkdirSync(plansDir, { recursive: true });

    const watcher = new CompletedFileWatcher(external, '*_[Cc]ompleted.md', [plansDir]);
    const observed = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('timed out waiting for the completed-file event')), 10_000);
      watcher.onCompleted((filePath) => {
        clearTimeout(timeout);
        resolve(filePath);
      });
    });

    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(path.join(plansDir, 'thing_plan_completed.md'), '# Done\n');

    try {
      await expect(observed).resolves.toBe(path.join(plansDir, 'thing_plan_completed.md'));
    } finally {
      await watcher.stop();
      fs.rmSync(external, { recursive: true, force: true });
    }
  }, 15_000);
});

/**
 * The stage machine measures the *baseline* the completion detector later
 * compares against, so the two must read the SAME tree. Phase 2 moved the
 * detector's plan read to the execution cwd while the stage machine still read
 * the repo root, which under isolation compares two different trees:
 *
 *  - root copy has unchecked boxes, worktree copy is fully ticked → the
 *    baseline says "not already done", the detector sees a fully-checked plan,
 *    and `plan-checklist` fires as a sufficient signal on iteration 0;
 *  - someone ticks the root copy mid-run → the baseline says "already done"
 *    and the signal stays suppressed for the whole run.
 *
 * Its scan of uncompleted plan docs has the same requirement: that list
 * auto-enables `requireCompletedFileRename`, and the rename is only ever
 * detected in the execution cwd.
 */
describe('LoopStageMachine reads work product from the execution cwd', () => {
  it('reads the plan file from the worktree, not the repo root', async () => {
    const machine = new LoopStageMachine(repoRoot, 'loop-1', worktree);
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.executionCwd = worktree;
    config.planFile = 'PLAN.md';
    fs.writeFileSync(path.join(repoRoot, 'PLAN.md'), '# root copy\n- [ ] open\n');
    fs.writeFileSync(path.join(worktree, 'PLAN.md'), '# worktree copy\n- [x] done\n');

    expect(await machine.readPlan(config)).toContain('worktree copy');
  });

  it('keeps loop state paths at the repo root even when isolated', () => {
    const machine = new LoopStageMachine(repoRoot, 'loop-1', worktree);

    expect(machine.paths.dir.startsWith(repoRoot)).toBe(true);
    expect(machine.paths.dir.startsWith(worktree)).toBe(false);
  });

  it('scans the worktree for uncompleted plan docs, not the repo root', async () => {
    const machine = new LoopStageMachine(repoRoot, 'loop-1', worktree);
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.executionCwd = worktree;
    // A root-only plan doc must NOT be counted: the agent cannot rename a file
    // that does not exist in its tree, so counting it would arm
    // `requireCompletedFileRename` against a gate that can never be satisfied.
    fs.writeFileSync(path.join(repoRoot, 'root-only_plan.md'), '# root only\n');
    fs.writeFileSync(path.join(worktree, 'in-worktree_plan.md'), '# in worktree\n');

    const snapshot = await machine.captureStartupSnapshot(config);

    expect(snapshot.uncompletedPlanFilesAtStart).toContain('in-worktree_plan.md');
    expect(snapshot.uncompletedPlanFilesAtStart).not.toContain('root-only_plan.md');
  });

  it('falls back to the single cwd when isolation is off', async () => {
    const machine = new LoopStageMachine(repoRoot, 'loop-1');
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.planFile = 'PLAN.md';
    fs.writeFileSync(path.join(repoRoot, 'PLAN.md'), '# root copy\n');

    expect(machine.executionCwd).toBe(repoRoot);
    expect(await machine.readPlan(config)).toContain('root copy');
  });
});

describe('blindReviewerWorkspaceStartError', () => {
  /** Stands in for `git rev-parse --is-inside-work-tree` over a set of dirs. */
  const diffCapable = (...dirs: string[]) => (cwd: string) => dirs.includes(cwd);
  const never = () => false;

  function reviewerBackedConfig(): ReturnType<typeof defaultLoopConfig> {
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.completion.crossModelReview = defaultCrossModelReviewConfig();
    return config;
  }

  it('refuses a reviewer-backed loop outside a git repository', () => {
    const error = blindReviewerWorkspaceStartError(reviewerBackedConfig(), never);

    expect(error).toContain('not a git repository');
    expect(error).toContain('empty diff');
  });

  it('names the git repository directly below the workspace when there is exactly one', () => {
    fs.mkdirSync(path.join(repoRoot, 'inner', '.git'), { recursive: true });

    expect(blindReviewerWorkspaceStartError(reviewerBackedConfig(), never))
      .toContain(path.join(repoRoot, 'inner'));
  });

  it('allows a reviewer-backed loop inside a git repository', () => {
    expect(blindReviewerWorkspaceStartError(reviewerBackedConfig(), diffCapable(repoRoot))).toBeNull();
  });

  /**
   * The predicate is `git rev-parse --is-inside-work-tree`, not `.git`
   * existence. A subdirectory of a repository has no `.git` of its own but
   * diffs perfectly well; stat-ing `.git` would refuse it outright.
   */
  it('allows a subdirectory of a repository, which has no .git of its own', () => {
    const sub = path.join(repoRoot, 'packages', 'thing');
    fs.mkdirSync(sub, { recursive: true });
    const config = defaultLoopConfig(sub, 'do thing');
    config.completion.crossModelReview = defaultCrossModelReviewConfig();

    expect(fs.existsSync(path.join(sub, '.git'))).toBe(false);
    expect(blindReviewerWorkspaceStartError(config, diffCapable(sub))).toBeNull();
  });

  it('checks the execution cwd, not the repo root, when isolated', () => {
    const config = reviewerBackedConfig();
    config.executionCwd = worktree;

    // Repo root diffs fine; the worktree does not. The guard must judge the
    // worktree, since that is where the agent works and the diff is collected.
    expect(blindReviewerWorkspaceStartError(config, diffCapable(repoRoot))).toContain(worktree);
    expect(blindReviewerWorkspaceStartError(config, diffCapable(worktree))).toBeNull();
  });

  it('allows a loop with no reviewer at all', () => {
    const config = defaultLoopConfig(repoRoot, 'do thing');
    config.completion.crossModelReview = undefined;

    expect(blindReviewerWorkspaceStartError(config, never)).toBeNull();
  });
});

/**
 * A ping-pong round spawns a whole agentic reviewer session. It used to inherit
 * `crossModelReview.timeoutSeconds` (90s, sized for the one-shot headless
 * reviewer), which timed out roughly half of all rounds — and an UNRELIABLE
 * round never advances `roundCount`, so convergence stalled indefinitely.
 */
describe('ping-pong reviewer budget', () => {
  it('defaults to 15 minutes, not the 90s cross-model review timeout', () => {
    expect(clampPingPongReviewerTimeoutSeconds(undefined)).toBe(PINGPONG_DEFAULT_REVIEWER_TIMEOUT_SECONDS);
    expect(PINGPONG_DEFAULT_REVIEWER_TIMEOUT_SECONDS).toBe(900);
    expect(defaultCrossModelReviewConfig().timeoutSeconds).toBe(90);
    expect(defaultPingPongConfig().reviewerTimeoutSeconds).toBe(900);
  });

  it('clamps out-of-range values instead of trusting them', () => {
    expect(clampPingPongReviewerTimeoutSeconds(5)).toBe(60);
    expect(clampPingPongReviewerTimeoutSeconds(99_999)).toBe(3600);
    expect(clampPingPongReviewerTimeoutSeconds(Number.NaN)).toBe(900);
    expect(clampPingPongReviewerTimeoutSeconds(300)).toBe(300);
  });
});
