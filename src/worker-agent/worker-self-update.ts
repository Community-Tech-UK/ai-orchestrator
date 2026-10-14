import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  WorkerAgentAutoUpdateState as WorkerAutoUpdateState,
  WorkerAgentAutoUpdateSummary as WorkerAutoUpdateSummary,
} from '../shared/types/worker-node.types';

/**
 * Automatic self-update for a worker that runs from a git checkout.
 *
 * Before this existed the update path on windows-pc was half a mechanism: the
 * launcher pulled new code every five minutes but nothing rebuilt or restarted
 * the worker, and Chrome loads the Harness extension straight out of the same
 * checkout. After every pull the worker, its native host and the extension ran
 * three different versions until someone restarted the worker and Chrome by
 * hand (diagnosed 2026-10-14; see docs/plans/2026-10-14-worker-auto-update_plan_completed.md).
 *
 * This applies an update as ONE unit, and only while the worker is idle:
 * fast-forward the checkout, build a candidate bundle beside the live one,
 * smoke-test it, swap it in, then exit with WORKER_UPDATE_RESTART_EXIT_CODE so
 * the supervisor respawns the child on the new bundle. The new relay then tells
 * the extension which version it expects, and the extension reloads itself.
 *
 * Any failure up to and including the swap undoes the fast-forward (back to the
 * commit HEAD was on before this update) and leaves the live bundle untouched,
 * so a bad commit can never take the node down. A failed commit is remembered
 * on disk (`.auto-update-failed`, read at startup) and retried after two hours;
 * a bundle that died on startup is not retried until upstream moves on.
 * Coordinator housekeeping (pings, health checks) never counts as work; see
 * worker-activity.ts.
 */

export const WORKER_UPDATE_RESTART_EXIT_CODE = 75;
/** Set by worker-supervisor.ts for its children. Without it nothing would respawn us. */
export const WORKER_SUPERVISED_ENV = 'AIO_WORKER_SUPERVISED';

const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;
const DEFAULT_FIRST_CHECK_DELAY_MS = 2 * 60_000;
const DEFAULT_QUIET_MS = 3 * 60_000;
const GIT_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
const SELF_CHECK_TIMEOUT_MS = 60_000;
const MAX_REASON_CHARS = 300;
const RETRY_FAILED_AFTER_MS = 2 * 60 * 60_000;

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<CommandResult>;

export interface SelfUpdateFs {
  exists(p: string): boolean;
  readText(p: string): string | null;
  writeText(p: string, text: string): void;
  copy(from: string, to: string): void;
  rename(from: string, to: string): void;
  remove(p: string): void;
}

export interface SelfUpdateLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface WorkerSelfUpdaterOptions {
  repoRoot: string;
  /** The live bundle, `<repo>/dist/worker-agent/index.js`. */
  bundlePath: string;
  /** Passed to the candidate's `--self-check`. */
  configPath?: string;
  /** True while anything is running that a restart would kill. */
  isBusy: () => boolean;
  /** Latest activity the busy probe cannot see at a sample instant (epoch ms). */
  lastActivityAt?: () => number;
  /** Disconnect cleanly, then exit with WORKER_UPDATE_RESTART_EXIT_CODE. */
  restart: () => Promise<void>;
  nodeExecutable?: string;
  run?: RunCommand;
  fs?: SelfUpdateFs;
  now?: () => number;
  logger?: SelfUpdateLogger;
  sampleIntervalMs?: number;
  checkIntervalMs?: number;
  firstCheckDelayMs?: number;
  quietMs?: number;
}

interface FailedTarget {
  commit: string;
  reason: string;
  /**
   * When the same commit may be tried again (epoch ms). Absent means never:
   * the supervisor records a bundle that died on startup that way. Everything
   * else can be transient on Windows (a timeout, a file a scanner held), and a
   * permanent block would strand the node on old code with nobody to notice.
   */
  retryAfter?: number;
}

interface GitPlan {
  head: string;
  target: string;
}

export class WorkerSelfUpdater {
  private readonly run: RunCommand;
  private readonly fs: SelfUpdateFs;
  private readonly now: () => number;
  private readonly logger: SelfUpdateLogger;
  private readonly nodeExecutable: string;
  private readonly stampPath: string;
  private readonly failedPath: string;
  private readonly candidatePath: string;
  private readonly previousPath: string;
  private readonly quietMs: number;
  private readonly checkIntervalMs: number;
  /** Commit the RUNNING bundle was built from; fixed for this process. */
  private readonly runningCommit: string | null;
  /** Commit the bundle ON DISK was built from; moves when an update is swapped in. */
  private diskCommit: string | null;
  private failed: FailedTarget | null;
  private summary: WorkerAutoUpdateSummary = { state: 'idle' };
  private lastBusyAt: number;
  private nextCheckAt: number;
  private checking = false;
  private restarting = false;
  private checkoutReturned = false;
  /** undefined = not yet decided; null = leave GIT_SSH_COMMAND alone. */
  private sshCommandOverride: string | null | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WorkerSelfUpdaterOptions) {
    this.run = options.run ?? runCommand;
    this.fs = options.fs ?? nodeFs;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? consoleLogger;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    const bundleDir = path.dirname(options.bundlePath);
    this.stampPath = path.join(bundleDir, '.source-commit');
    this.failedPath = path.join(bundleDir, '.auto-update-failed');
    this.candidatePath = path.join(bundleDir, 'index.next.js');
    this.previousPath = path.join(bundleDir, 'index.prev.js');
    this.quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.runningCommit = readCommit(this.fs.readText(this.stampPath));
    this.diskCommit = this.runningCommit;
    this.failed = parseFailedTarget(this.fs.readText(this.failedPath));
    const startedAt = this.now();
    this.lastBusyAt = startedAt;
    this.nextCheckAt = startedAt + (options.firstCheckDelayMs ?? DEFAULT_FIRST_CHECK_DELAY_MS);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSummary(): WorkerAutoUpdateSummary {
    return { ...this.summary };
  }

  getRunningCommit(): string | null {
    return this.runningCommit;
  }

  /** One sampler step. Exposed so tests drive the loop without real timers. */
  async tick(): Promise<void> {
    this.sampleBusy();
    if (this.checking || this.restarting || this.now() < this.nextCheckAt) return;
    this.checking = true;
    try {
      await this.check();
    } catch (error) {
      this.block(errorMessage(error));
    } finally {
      this.checking = false;
      this.summary.lastCheckedAt = this.now();
      this.nextCheckAt = this.now() + this.checkIntervalMs;
    }
  }

  private sampleBusy(): void {
    if (this.options.isBusy()) {
      this.lastBusyAt = this.now();
    }
  }

  private isQuiet(): boolean {
    this.sampleBusy();
    const lastActivity = Math.max(this.lastBusyAt, this.options.lastActivityAt?.() ?? 0);
    return this.now() - lastActivity >= this.quietMs;
  }

  private async check(): Promise<void> {
    if (this.summary.state === 'restart_pending') {
      await this.restartWhenQuiet();
      return;
    }
    const plan = await this.planUpdate();
    if (!plan) return;
    if (this.failed?.commit === plan.target && !this.isRetryDue(this.failed)) {
      await this.returnCheckoutToRunningBuild(plan.head);
      const retry = this.failed.retryAfter === undefined
        ? 'not retried until upstream moves on'
        : `retrying after ${new Date(this.failed.retryAfter).toISOString()}`;
      this.setSummary('blocked', `update to ${short(plan.target)} failed earlier (${retry}): ${this.failed.reason}`, plan.target);
      return;
    }
    if (!this.isQuiet()) {
      this.setSummary('waiting_for_idle', undefined, plan.target);
      return;
    }
    await this.apply(plan);
  }

  /** Null when there is nothing to do (summary already set). */
  private async planUpdate(): Promise<GitPlan | null> {
    // Offline or no credentials is not an update failure. Carry on with the refs
    // already on disk: an older launcher may have pulled without rebuilding.
    const fetch = await this.git(['fetch', '--quiet']);
    const fetchNote = fetch.code === 0 ? undefined : `git fetch failed: ${firstLine(fetch.stderr)}`;
    const head = await this.revParse('HEAD');
    if (!head) throw new Error('could not read HEAD');
    const upstream = await this.revParse('@{u}');
    let target = head;
    if (upstream && upstream !== head) {
      if (await this.isAncestor(head, upstream)) {
        target = upstream;
      } else if (!(await this.isAncestor(upstream, head))) {
        this.setSummary('blocked', 'the checkout has diverged from its upstream branch');
        return null;
      }
    }
    if (target === head && target === this.diskCommit) {
      this.setSummary('idle', fetchNote);
      return null;
    }
    return { head, target };
  }

  private async apply(plan: GitPlan): Promise<void> {
    this.setSummary('updating', undefined, plan.target);
    this.logger.info('[WorkerSelfUpdate] Updating worker', {
      from: this.diskCommit ? short(this.diskCommit) : 'unknown',
      to: short(plan.target),
    });
    let moved = false;
    try {
      if (plan.target !== plan.head) {
        const merge = await this.git(['merge', '--ff-only', '--quiet', plan.target]);
        if (merge.code !== 0) throw new UpdateStepError('git merge --ff-only', merge);
        moved = true;
      }
      this.fs.remove(this.candidatePath);
      const build = await this.run(
        this.nodeExecutable,
        [path.join(this.options.repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'build-worker-agent.ts'],
        {
          cwd: this.options.repoRoot,
          timeoutMs: BUILD_TIMEOUT_MS,
          env: { ...process.env, AIO_WORKER_BUILD_OUTFILE: this.candidatePath },
        },
      );
      if (build.code !== 0 || !this.fs.exists(this.candidatePath)) throw new UpdateStepError('build', build);
      const selfCheck = await this.run(
        this.nodeExecutable,
        [this.candidatePath, '--self-check', ...(this.options.configPath ? ['--config', this.options.configPath] : [])],
        { cwd: this.options.repoRoot, timeoutMs: SELF_CHECK_TIMEOUT_MS },
      );
      if (selfCheck.code !== 0) throw new UpdateStepError('self-check of the new bundle', selfCheck);
    } catch (error) {
      await this.rollBack(plan, moved, errorMessage(error));
      return;
    }

    // Swap the files. The running process keeps its old code in memory; the
    // next child (crash or planned restart) loads the new one. The previous
    // bundle and its stamp stay beside it so the supervisor can put them back
    // if the new one dies on startup (restorePreviousWorkerBundle).
    //
    // Windows can refuse any of these (a scanner or indexer briefly holding a
    // file). Undo a half-done swap rather than leave a new bundle under the old
    // stamp: the next swap would then save that new bundle as "previous" and
    // the good one would be gone.
    let swapped = false;
    try {
      if (this.fs.exists(this.options.bundlePath)) {
        this.fs.copy(this.options.bundlePath, this.previousPath);
        this.fs.writeText(`${this.stampPath}.prev`, this.diskCommit ? `${this.diskCommit}\n` : '');
      }
      this.fs.rename(this.candidatePath, this.options.bundlePath);
      swapped = true;
      this.fs.writeText(this.stampPath, `${plan.target}\n`);
      // Names the bundle this swap put in place. The supervisor restores
      // index.prev.js only while the bundle on disk is still this one, never
      // over a later manual rebuild (start-worker.bat, update-running-worker.ps1).
      this.fs.writeText(`${this.stampPath}.swapped`, `${plan.target}\n`);
    } catch (error) {
      let reason = `could not swap in the new bundle: ${errorMessage(error)}`;
      if (swapped) {
        // Put back all three: the bundle, its stamp and no swap marker. A new
        // stamp over the old bundle would make the worker believe it is current.
        const undo: [string, () => void][] = [
          ['bundle', () => this.fs.copy(this.previousPath, this.options.bundlePath)],
          ['stamp', () => (this.diskCommit
            ? this.fs.writeText(this.stampPath, `${this.diskCommit}\n`)
            : this.fs.remove(this.stampPath))],
          ['swap marker', () => this.fs.remove(`${this.stampPath}.swapped`)],
        ];
        for (const [what, step] of undo) {
          try {
            step();
          } catch (restoreError) {
            reason += `; restoring the previous ${what} also failed: ${errorMessage(restoreError)}`;
          }
        }
      }
      await this.rollBack(plan, moved, reason);
      return;
    }
    // Record the new state BEFORE any best-effort cleanup, so a cleanup error
    // cannot strand a swapped-in bundle that nothing restarts onto.
    this.diskCommit = plan.target;
    this.setSummary('restart_pending', undefined, plan.target);
    this.logger.info('[WorkerSelfUpdate] New bundle in place', { commit: short(plan.target) });
    this.clearFailed();
    await this.restartWhenQuiet();
  }

  private async restartWhenQuiet(): Promise<void> {
    if (!this.isQuiet()) {
      this.setSummary('restart_pending', 'waiting for running work to finish', this.summary.targetCommit);
      return;
    }
    this.restarting = true;
    this.logger.info('[WorkerSelfUpdate] Restarting onto the new bundle', {
      commit: this.diskCommit ? short(this.diskCommit) : 'unknown',
    });
    try {
      await this.options.restart();
    } catch (error) {
      this.restarting = false;
      this.setSummary('restart_pending', `restart failed: ${errorMessage(error)}`, this.summary.targetCommit);
    }
  }

  private async rollBack(plan: GitPlan, moved: boolean, reason: string): Promise<void> {
    let detail = reason;
    try {
      this.fs.remove(this.candidatePath);
    } catch {
      // A leftover candidate is removed before the next build anyway.
    }
    if (moved) {
      // Only undo our own fast-forward: if someone committed or checked out by
      // hand during the build, HEAD is theirs and must not be rewound.
      const current = await this.revParse('HEAD');
      if (current !== plan.target) {
        detail = `${reason}; the checkout moved during the update, so it was left at ${current ? short(current) : 'an unknown commit'}`;
      } else {
        // --keep refuses rather than discarding local edits that the two commits touch.
        const reset = await this.git(['reset', '--keep', plan.head]);
        if (reset.code !== 0) {
          detail = `${reason}; rolling the checkout back to ${short(plan.head)} also failed: ${firstLine(reset.stderr)}`;
        }
      }
    }
    this.recordFailed({ commit: plan.target, reason: truncate(detail), retryAfter: this.now() + RETRY_FAILED_AFTER_MS });
    this.logger.warn('[WorkerSelfUpdate] Update failed; the running worker is unchanged', {
      target: short(plan.target),
      reason: truncate(detail),
    });
    this.setSummary('blocked', detail, plan.target);
  }

  /**
   * After the supervisor restored the previous bundle, the checkout is still on
   * the failed commit, so the extension files Chrome loads no longer match the
   * running worker. Move it back once. Only once per process: an older launcher
   * that still pulls on its own would otherwise flip it back and forth.
   */
  private async returnCheckoutToRunningBuild(head: string): Promise<void> {
    const running = this.runningCommit;
    if (this.checkoutReturned || !running || head === running || head !== this.failed?.commit) return;
    if (!this.isQuiet()) return;
    // Never rewind a commit that exists only here: once the branch moves back,
    // a local-only commit would survive only in the reflog.
    const upstream = await this.revParse('@{u}');
    if (!upstream || !(await this.isAncestor(head, upstream))) return;
    this.checkoutReturned = true;
    const reset = await this.git(['reset', '--keep', running]);
    if (reset.code === 0) {
      this.logger.info('[WorkerSelfUpdate] Checkout returned to the running build', { commit: short(running) });
    } else {
      this.logger.warn('[WorkerSelfUpdate] Could not return the checkout to the running build', {
        reason: firstLine(reset.stderr),
      });
    }
  }

  private block(reason: string): void {
    this.logger.warn('[WorkerSelfUpdate] Update check failed', { reason: truncate(reason) });
    this.setSummary('blocked', reason, this.summary.targetCommit);
  }

  private setSummary(state: WorkerAutoUpdateState, reason?: string, targetCommit?: string): void {
    this.summary = {
      state,
      ...(reason ? { reason: truncate(reason) } : {}),
      ...(targetCommit ? { targetCommit } : {}),
      ...(this.summary.lastCheckedAt !== undefined ? { lastCheckedAt: this.summary.lastCheckedAt } : {}),
    };
  }

  private recordFailed(failed: FailedTarget): void {
    this.failed = failed;
    try {
      this.fs.writeText(this.failedPath, `${JSON.stringify(failed)}\n`);
    } catch {
      // In-memory memory of the failure still prevents a retry loop this run.
    }
  }

  private clearFailed(): void {
    this.failed = null;
    try {
      this.fs.remove(this.failedPath);
    } catch {
      // A stale record only matters if this same commit fails again later.
    }
  }

  private isRetryDue(failed: FailedTarget): boolean {
    return failed.retryAfter !== undefined && this.now() >= failed.retryAfter;
  }

  private async git(args: string[]): Promise<CommandResult> {
    return this.run('git', args, { cwd: this.options.repoRoot, timeoutMs: GIT_TIMEOUT_MS, env: await this.gitEnv() });
  }

  /**
   * Never wait on a prompt nobody can answer. BatchMode is added only when
   * nothing else chose an ssh command: GIT_SSH_COMMAND overrides
   * core.sshCommand, and a checkout that names its key there must keep working.
   */
  private async gitEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.sshCommandOverride === undefined) {
      const configured = process.env['GIT_SSH_COMMAND']
        || process.env['GIT_SSH']
        || (await this.run('git', ['config', '--get', 'core.sshCommand'], {
          cwd: this.options.repoRoot,
          timeoutMs: GIT_TIMEOUT_MS,
        })).stdout.trim();
      this.sshCommandOverride = configured ? null : 'ssh -o BatchMode=yes';
    }
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      ...(this.sshCommandOverride ? { GIT_SSH_COMMAND: this.sshCommandOverride } : {}),
    };
  }

  private async revParse(ref: string): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', ref]);
    return result.code === 0 ? readCommit(result.stdout) : null;
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return (await this.git(['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
  }
}

export interface CreateWorkerSelfUpdaterInput {
  enabledInConfig: boolean;
  env: NodeJS.ProcessEnv;
  entrypoint: string | undefined;
  exists?: (p: string) => boolean;
}

/**
 * Where the checkout is, or why self-update is off. The bundle must be the
 * standard `<repo>/dist/worker-agent/index.js` of a git checkout that can build
 * itself, and something must be there to respawn the process after it exits.
 */
export function resolveSelfUpdateTarget(
  input: CreateWorkerSelfUpdaterInput,
): { repoRoot: string; bundlePath: string } | { disabledReason: string } {
  const exists = input.exists ?? fs.existsSync;
  if (!input.enabledInConfig) return { disabledReason: 'turned off in worker config' };
  if (input.env[WORKER_SUPERVISED_ENV] !== '1') {
    return { disabledReason: 'not running under the worker supervisor' };
  }
  if (!input.entrypoint) return { disabledReason: 'no entrypoint script' };
  const bundlePath = path.resolve(input.entrypoint);
  const bundleDir = path.dirname(bundlePath);
  if (path.basename(bundlePath) !== 'index.js' || path.basename(bundleDir) !== 'worker-agent') {
    return { disabledReason: 'not running from dist/worker-agent/index.js' };
  }
  const repoRoot = path.resolve(bundleDir, '..', '..');
  const required = [
    '.git',
    'build-worker-agent.ts',
    path.join('node_modules', 'tsx', 'dist', 'cli.mjs'),
  ];
  for (const entry of required) {
    if (!exists(path.join(repoRoot, entry))) {
      return { disabledReason: `not a buildable git checkout (missing ${entry})` };
    }
  }
  return { repoRoot, bundlePath };
}

/**
 * Called by the supervisor when the first child after an update restart exits
 * before it was ever stable. Puts the previous bundle and its build stamp back
 * and records the new commit as failed, so the restored worker does not simply
 * try the same update again. Returns false when there is nothing to restore.
 */
export function restorePreviousWorkerBundle(
  entrypoint: string | undefined,
  fsOps: SelfUpdateFs = nodeFs,
): boolean {
  if (!entrypoint) return false;
  const bundlePath = path.resolve(entrypoint);
  const dir = path.dirname(bundlePath);
  const previousPath = path.join(dir, 'index.prev.js');
  const stampPath = path.join(dir, '.source-commit');
  if (!fsOps.exists(previousPath)) return false;
  // readText never throws (null on error), so these reads need no fence.
  const failedCommit = readCommit(fsOps.readText(stampPath));
  const swappedCommit = readCommit(fsOps.readText(`${stampPath}.swapped`));
  // index.prev.js is only the predecessor of the bundle an update swapped in.
  // Anything else on disk (a manual rebuild) must not be replaced by it.
  if (!failedCommit || failedCommit !== swappedCommit) return false;
  const previousCommit = readCommit(fsOps.readText(`${stampPath}.prev`));
  const attempt = (step: () => void): boolean => {
    try {
      step();
      return true;
    } catch {
      return false;
    }
  };

  // Each step on its own: Windows can refuse any single file, and one refusal
  // must not leave a half-restored state. The failure record goes FIRST, so a
  // restored worker never rebuilds the commit that just crashed.
  if (failedCommit !== previousCommit) {
    const failed: FailedTarget = { commit: failedCommit, reason: 'the new bundle exited during startup' };
    attempt(() => fsOps.writeText(path.join(dir, '.auto-update-failed'), `${JSON.stringify(failed)}\n`));
  }
  if (!attempt(() => fsOps.copy(previousPath, bundlePath))) return false;
  // The stamp must never name the failed commit over the old bundle: that worker
  // would believe it is current and never update. If it cannot be rewritten,
  // an absent stamp means "unknown, rebuild", which the failure record keeps
  // from choosing the crashed commit again.
  const stampRestored = previousCommit
    ? attempt(() => fsOps.writeText(stampPath, `${previousCommit}\n`))
    : attempt(() => fsOps.remove(stampPath));
  if (!stampRestored) attempt(() => fsOps.remove(stampPath));
  attempt(() => fsOps.remove(previousPath));
  attempt(() => fsOps.remove(`${stampPath}.swapped`));
  return true;
}

class UpdateStepError extends Error {
  constructor(step: string, result: CommandResult) {
    super(`${step} failed (exit ${result.code}): ${firstLine(result.stderr || result.stdout)}`);
  }
}

function readCommit(text: string | null): string | null {
  const value = text?.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

function parseFailedTarget(text: string | null): FailedTarget | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<FailedTarget>;
    const commit = readCommit(typeof value.commit === 'string' ? value.commit : null);
    if (!commit) return null;
    return {
      commit,
      reason: typeof value.reason === 'string' ? value.reason : 'unknown',
      ...(typeof value.retryAfter === 'number' && Number.isFinite(value.retryAfter) ? { retryAfter: value.retryAfter } : {}),
    };
  } catch {
    return null;
  }
}

function short(commit: string): string {
  return commit.slice(0, 8);
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line ? truncate(line) : 'no output';
}

function truncate(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const runCommand: RunCommand = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && code !== 0 ? error.message : '')) });
      },
    );
  });

const nodeFs: SelfUpdateFs = {
  exists: (p) => fs.existsSync(p),
  readText: (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  },
  writeText: (p, text) => fs.writeFileSync(p, text, 'utf8'),
  copy: (from, to) => fs.copyFileSync(from, to),
  rename: (from, to) => fs.renameSync(from, to),
  remove: (p) => fs.rmSync(p, { force: true }),
};

const consoleLogger: SelfUpdateLogger = {
  info: (message, meta) => console.log(message, meta ?? ''),
  warn: (message, meta) => console.warn(message, meta ?? ''),
};
