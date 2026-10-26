import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  restorePreviousWorkerBundle,
  WORKER_SUPERVISED_ENV,
  WORKER_UPDATE_RESTART_EXIT_CODE,
} from './worker-self-update';

/**
 * Self-supervision for the worker agent.
 *
 * Even with crash-proofing, a worker can still die — OOM kill, a fatal config
 * error, a native module fault, or a bug we have not found yet. When it is
 * launched headless (Windows Startup VBS, detached process) nothing brings it
 * back until the user logs in again. `--supervise` runs a thin parent loop in
 * the SAME entrypoint that forks the real worker as a child and restarts it with
 * capped exponential backoff + jitter, giving up only after a burst of rapid
 * failures (a genuinely broken install, not a transient crash).
 *
 * Dependency-light on purpose (workers must not import `electron`). Everything
 * with a side effect — spawning, sleeping, the clock, logging — is injectable so
 * the loop is unit-testable without real processes or timers.
 */

export interface SupervisedChildHandle {
  readonly pid?: number;
  /** Register the single exit callback. Called once with the child's exit. */
  onExit(cb: (result: { code: number | null; signal: NodeJS.Signals | null }) => void): void;
  /** Ask the child to stop. */
  kill(signal?: NodeJS.Signals): void;
}

export interface WorkerSupervisorOptions {
  /** Args passed to each spawned child (the parent argv minus `--supervise`). */
  childArgs: string[];
  /**
   * Spawn a child. Injectable for tests; defaults to a real `child_process.spawn`.
   * `previousChildPid` is the child this supervisor last saw exit (see
   * WORKER_PREVIOUS_CHILD_PID_ENV).
   */
  spawnChild?: (childArgs: string[], previousChildPid?: number) => SupervisedChildHandle;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** First restart delay. Default 1000ms. */
  initialBackoffMs?: number;
  /** Cap on the restart delay. Default 30000ms. */
  maxBackoffMs?: number;
  /** Backoff growth factor. Default 2. */
  backoffFactor?: number;
  /**
   * A child that stays up at least this long is considered "stable" and resets
   * the rapid-failure counter and backoff. Default 60000ms.
   */
  stableRuntimeMs?: number;
  /**
   * Give up after this many consecutive rapid (sub-stable) failures. Default 5.
   */
  maxRapidRestarts?: number;
  /** Injectable clock (ms). Default `Date.now`. */
  now?: () => number;
  /** Injectable sleep. Default a real `setTimeout` promise. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1). Default `Math.random`. */
  random?: () => number;
  /** Pause before respawning a child that exited to load an update. Default 500ms. */
  updateRestartDelayMs?: number;
  /**
   * Put the pre-update bundle back. Called when the first child after an update
   * restart dies before it was stable. Returns false when there is nothing to
   * restore. Default: restorePreviousWorkerBundle on this entrypoint.
   */
  restorePreviousBundle?: () => boolean;
  /**
   * Identifies the bundle on disk at spawn time. A rapid failure on a bundle
   * other than the last one that ran stably counts as a failed update too: the
   * updater may have swapped a new bundle in while the worker was busy, and a
   * crash then respawns onto it without any exit-75 restart. Default: the
   * entrypoint's size and modification time; null when unreadable.
   */
  bundleFingerprint?: () => string | null;
}

const DEFAULTS = {
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  backoffFactor: 2,
  stableRuntimeMs: 60_000,
  maxRapidRestarts: 5,
  updateRestartDelayMs: 500,
};

/**
 * The pid of the child this supervisor last saw exit. A force-killed child
 * leaves its single-instance lock behind, and Windows can hand its pid to
 * another process within a second, so the respawn would otherwise read the
 * lock as held, exit 0 as a duplicate, and stop the supervisor for good.
 */
export const WORKER_PREVIOUS_CHILD_PID_ENV = 'AIO_WORKER_PREVIOUS_CHILD_PID';

/**
 * Child environment: tells the child something will respawn it (self-update
 * needs that) and which child exited before it.
 */
export function workerChildEnv(env: NodeJS.ProcessEnv, previousChildPid?: number): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env, [WORKER_SUPERVISED_ENV]: '1' };
  delete childEnv[WORKER_PREVIOUS_CHILD_PID_ENV];
  if (previousChildPid !== undefined) {
    childEnv[WORKER_PREVIOUS_CHILD_PID_ENV] = String(previousChildPid);
  }
  return childEnv;
}

export function previousChildPidFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const pid = Number.parseInt(env[WORKER_PREVIOUS_CHILD_PID_ENV] ?? '', 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Resolve the command used to relaunch the worker as a child. Mirrors the
 * native-host command resolution: when run as `node index.js` we re-invoke the
 * script; when run as a packaged single-executable we re-invoke the binary.
 */
export function resolveWorkerChildCommand(childArgs: string[]): { exe: string; args: string[] } {
  const entrypoint = process.argv[1];
  if (entrypoint && path.resolve(entrypoint) !== path.resolve(process.execPath)) {
    return { exe: process.execPath, args: [entrypoint, ...childArgs] };
  }
  return { exe: process.execPath, args: [...childArgs] };
}

function defaultSpawnChild(childArgs: string[], previousChildPid?: number): SupervisedChildHandle {
  const { exe, args } = resolveWorkerChildCommand(childArgs);
  const child = spawn(exe, args, {
    stdio: 'inherit',
    env: workerChildEnv(process.env, previousChildPid),
  });
  return {
    pid: child.pid,
    onExit: (cb) => {
      child.once('exit', (code, signal) => cb({ code, signal }));
      // A spawn error (ENOENT etc.) never emits 'exit'; surface it as a failure
      // so the loop retries/backs off instead of hanging forever.
      child.once('error', () => cb({ code: 1, signal: null }));
    },
    kill: (signal) => {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Run the supervisor loop. Resolves with a process exit code:
 *   0 — the worker (or the supervisor) stopped intentionally,
 *   1 — the worker crashed too many times in a row and we gave up.
 */
export async function runWorkerSupervisor(options: WorkerSupervisorOptions): Promise<number> {
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  const log = options.logger ?? consoleLogger();
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULTS.initialBackoffMs;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
  const backoffFactor = options.backoffFactor ?? DEFAULTS.backoffFactor;
  const stableRuntimeMs = options.stableRuntimeMs ?? DEFAULTS.stableRuntimeMs;
  const maxRapidRestarts = options.maxRapidRestarts ?? DEFAULTS.maxRapidRestarts;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = options.random ?? Math.random;
  const restorePreviousBundle = options.restorePreviousBundle
    ?? (() => restorePreviousWorkerBundle(process.argv[1]));

  let stopping = false;
  let previousExitWasUpdate = false;
  const bundleFingerprint = options.bundleFingerprint ?? (() => defaultBundleFingerprint(process.argv[1]));
  let lastStableFingerprint: string | null = null;
  let current: SupervisedChildHandle | null = null;
  let previousChildPid: number | undefined;
  let rapidFailures = 0;
  let backoff = initialBackoffMs;
  let restarts = 0;

  const onSignal = (signal: NodeJS.Signals): void => {
    stopping = true;
    log.info('Supervisor received signal — stopping worker', { signal });
    current?.kill(signal);
  };
  const sigintHandler = (): void => onSignal('SIGINT');
  const sigtermHandler = (): void => onSignal('SIGTERM');
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigtermHandler);

  log.info('Worker supervisor started', {
    maxRapidRestarts,
    stableRuntimeMs,
    pid: process.pid,
  });

  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const startedAt = now();
      const spawnedFingerprint = bundleFingerprint();
      const child = spawnChild(options.childArgs, previousChildPid);
      current = child;
      log.info('Worker child started', { pid: child.pid, restarts });

      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.onExit(resolve),
      );
      current = null;
      previousChildPid = child.pid;
      const ranMs = now() - startedAt;

      if (stopping) {
        log.info('Worker child exited during shutdown', { code: result.code, signal: result.signal });
        return 0;
      }

      // A clean exit (code 0) is an intentional stop (e.g. the child received
      // SIGINT/SIGTERM and shut down). Do not fight the operator by respawning.
      if (result.code === 0) {
        log.info('Worker child exited cleanly — supervisor stopping', { ranMs });
        return 0;
      }

      // A planned exit to load a freshly built bundle. Not a crash: it must not
      // spend the rapid-failure budget or grow the backoff.
      if (result.code === WORKER_UPDATE_RESTART_EXIT_CODE) {
        previousExitWasUpdate = true;
        restarts++;
        log.info('Worker child exited to load an update — restarting', { ranMs, restarts });
        await delay(options.updateRestartDelayMs ?? DEFAULTS.updateRestartDelayMs);
        continue;
      }

      // The first child on a new bundle died before it was ever stable. Do not
      // burn the rapid-failure budget on a bad update and then give up, which
      // would leave the node offline: go back to the bundle that worked.
      const bundleChanged = lastStableFingerprint !== null
        && spawnedFingerprint !== null
        && spawnedFingerprint !== lastStableFingerprint;
      if (ranMs >= stableRuntimeMs) lastStableFingerprint = spawnedFingerprint;
      const failedRightAfterUpdate: boolean = (previousExitWasUpdate || bundleChanged) && ranMs < stableRuntimeMs;
      const restored: boolean = failedRightAfterUpdate && restorePreviousBundle();
      // Stay armed until a restore succeeds or a child runs stably: Windows can
      // refuse the copy once (a scanner holding the file), and giving up after
      // the first refusal would let a bad bundle burn the rapid-failure budget.
      previousExitWasUpdate = failedRightAfterUpdate && !restored;
      if (restored) {
        restarts++;
        log.warn('Worker failed on the updated bundle — restored the previous one', {
          code: result.code,
          signal: result.signal,
          ranMs,
          restarts,
        });
        await delay(options.updateRestartDelayMs ?? DEFAULTS.updateRestartDelayMs);
        continue;
      }

      if (ranMs >= stableRuntimeMs) {
        // The child was up long enough to count as healthy; the crash is fresh,
        // not a boot-loop. Reset the failure budget.
        rapidFailures = 0;
        backoff = initialBackoffMs;
      } else {
        rapidFailures++;
      }

      if (rapidFailures >= maxRapidRestarts) {
        log.error('Worker crashed repeatedly — supervisor giving up', {
          rapidFailures,
          lastCode: result.code,
          lastSignal: result.signal,
        });
        return 1;
      }

      const waitMs = jitter(backoff, random);
      restarts++;
      log.warn('Worker child exited — restarting', {
        code: result.code,
        signal: result.signal,
        ranMs,
        rapidFailures,
        waitMs,
        restarts,
      });
      await delay(waitMs);
      backoff = Math.min(maxBackoffMs, backoff * backoffFactor);
    }
  } finally {
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  }
}

function defaultBundleFingerprint(entrypoint: string | undefined): string | null {
  if (!entrypoint) return null;
  try {
    const stat = fs.statSync(entrypoint);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/** Half-fixed / half-random jitter, matching the reconnect backoff shape. */
function jitter(baseMs: number, random: () => number): number {
  return Math.floor(baseMs / 2 + random() * (baseMs / 2));
}

function consoleLogger(): NonNullable<WorkerSupervisorOptions['logger']> {
  const fmt = (msg: string, meta?: Record<string, unknown>): string =>
    meta && Object.keys(meta).length > 0 ? `[Supervisor] ${msg} ${JSON.stringify(meta)}` : `[Supervisor] ${msg}`;
  return {
    info: (msg, meta) => console.log(fmt(msg, meta)),
    warn: (msg, meta) => console.warn(fmt(msg, meta)),
    error: (msg, meta) => console.error(fmt(msg, meta)),
  };
}
