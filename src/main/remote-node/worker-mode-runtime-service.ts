import { spawn as defaultSpawn, spawnSync, type SpawnOptions } from 'node:child_process';
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  rmSync,
} from 'node:fs';
import * as path from 'node:path';
import type {
  WorkerModeConfigSummary,
  WorkerModeRuntimeSnapshot,
} from '../../shared/types/pair-both.types';
import type { WorkerConfig } from '../../worker-agent/worker-config';

export interface WorkerModeRuntimeCommand {
  command: string;
  args: string[];
}

export interface ResolveWorkerModeRuntimeCommandOptions {
  resourcesPath?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  existsSync?: (candidate: string) => boolean;
}

export type WorkerModeRuntimeStatus = WorkerModeRuntimeSnapshot;

/** How long a stop waits for the worker to exit before moving on. */
const STOP_WAIT_TIMEOUT_MS = 5_000;

export interface WorkerModeRuntimeStartOptions {
  configPath: string;
}

export interface WorkerModeServiceInstallOptions {
  configPath: string;
  config: WorkerConfig;
}

interface ChildProcessLike {
  readonly pid?: number;
  readonly killed?: boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

type SpawnWorker = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcessLike;

/** Stops the spawned worker and everything it launched. */
type KillWorkerTree = (child: ChildProcessLike) => void;

export interface WorkerModeRuntimeServiceOptions {
  spawn?: SpawnWorker;
  resolveCommand?: () => WorkerModeRuntimeCommand;
  killTree?: KillWorkerTree;
  now?: () => number;
}

export class WorkerModeRuntimeService {
  private readonly spawn: SpawnWorker;
  private readonly resolveCommand: () => WorkerModeRuntimeCommand;
  private readonly killTree: KillWorkerTree;
  private child: ChildProcessLike | null = null;
  private activeCommand: string | undefined;
  private lastError: string | undefined;
  private stopRequestedAt: number | null = null;
  private readonly now: () => number;

  constructor(options: WorkerModeRuntimeServiceOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.resolveCommand = options.resolveCommand ?? (() => resolveWorkerModeRuntimeCommand());
    this.killTree = options.killTree ?? defaultKillWorkerTree;
    this.now = options.now ?? Date.now;
  }

  start(options: WorkerModeRuntimeStartOptions): WorkerModeRuntimeStatus {
    if (this.child && !this.child.killed) {
      return this.status();
    }

    const resolved = this.resolveCommand();
    const args = [...resolved.args, '--config', options.configPath, '--supervise'];
    const child = this.spawn(resolved.command, args, {
      detached: false,
      stdio: 'ignore',
      // Without this, Windows gives the console-subsystem worker its own
      // visible console window, and closing that window kills the worker.
      windowsHide: true,
      env: buildWorkerRuntimeEnv(),
    });
    this.child = child;
    this.activeCommand = resolved.command;
    this.lastError = undefined;
    this.stopRequestedAt = null;

    child.once('exit', (code, signal) => {
      if (this.child === child) {
        this.child = null;
        // Only an exit we did not ask for reaches here (stop() clears
        // this.child first). The supervisor exits 0 when it stops on purpose
        // — including when another worker for this node already holds the
        // single-instance lock — and non-zero when it gave up on crashes.
        if (code !== 0) {
          this.lastError = `The worker stopped unexpectedly (${code !== null ? `exit code ${code}` : `signal ${signal ?? 'unknown'}`}).`;
        }
      }
    });
    child.once('error', (error) => {
      this.lastError = error.message;
      if (this.child === child) {
        this.child = null;
      }
    });

    return this.status();
  }

  async installService(options: WorkerModeServiceInstallOptions): Promise<WorkerModeRuntimeStatus> {
    const coordinatorUrl = options.config.coordinatorUrl ?? options.config.coordinatorUrls?.[0];
    if (!coordinatorUrl) {
      throw new Error('Worker service install needs a coordinator URL from the paired worker config.');
    }
    const token = options.config.authToken;
    if (!token) {
      throw new Error('Worker service install needs the freshly paired worker credential.');
    }

    this.stop();
    const resolved = this.resolveCommand();
    const tokenEnvName = 'AIO_WORKER_INSTALL_TOKEN';
    const child = this.spawn(resolved.command, [
      ...resolved.args,
      '--install-service',
      '--coordinator-url',
      coordinatorUrl,
      '--token-env',
      tokenEnvName,
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...buildWorkerRuntimeEnv(),
        [tokenEnvName]: token,
      },
    });

    await waitForChildExit(child, 'Worker service installation failed');
    this.activeCommand = resolved.command;
    this.lastError = undefined;
    return {
      state: 'service-installed',
      command: resolved.command,
    };
  }

  stop(): WorkerModeRuntimeStatus {
    const child = this.child;
    this.child = null;
    if (child) {
      this.stopRequestedAt = this.now();
      this.killTree(child);
    }
    return this.status();
  }

  /** Harness stopped its worker within the last few seconds (it may still be exiting). */
  stoppedRecently(windowMs = STOP_WAIT_TIMEOUT_MS): boolean {
    return this.stopRequestedAt !== null && this.now() - this.stopRequestedAt < windowMs;
  }

  /**
   * Stop and wait for the worker to exit. Use this before rewriting or deleting
   * its config: a still-running worker keeps its old credential in memory and
   * persists that config back to disk (enrollment, rejection, advertised URLs),
   * which silently undid a re-pair or an unpair. Waiting also frees the
   * single-instance lock so an immediate restart is not refused.
   */
  async stopAndWait(timeoutMs = STOP_WAIT_TIMEOUT_MS): Promise<WorkerModeRuntimeStatus> {
    const child = this.child;
    if (!child) {
      return this.status();
    }
    let timer: NodeJS.Timeout | undefined;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    });
    this.stop();
    await exited;
    clearTimeout(timer);
    return this.status();
  }

  status(): WorkerModeRuntimeStatus {
    if (this.child && !this.child.killed) {
      return {
        state: 'running',
        ...(this.child.pid ? { pid: this.child.pid } : {}),
        ...(this.activeCommand ? { command: this.activeCommand } : {}),
      };
    }
    return {
      state: 'stopped',
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

export function clearWorkerModeConfig(configPath: string): void {
  rmSync(configPath, { force: true });
}

export interface WorkerModePairing {
  paired: boolean;
  enrolled: boolean;
  config: WorkerModeConfigSummary | null;
}

export interface ReadWorkerModePairingOptions {
  existsSync?: (candidate: string) => boolean;
  readFileSync?: (candidate: string, encoding: 'utf-8') => string;
}

/**
 * Read the saved pairing without side effects. Throws when the file exists but
 * cannot be parsed. `loadWorkerConfig()` is not usable here: it writes the
 * file back, mints a node id, and applies the calling process's CLI flags —
 * none of which a status poll may do.
 */
export function readWorkerModePairing(
  configPath: string,
  options: ReadWorkerModePairingOptions = {},
): WorkerModePairing {
  const existsSync = options.existsSync ?? defaultExistsSync;
  const readFileSync = options.readFileSync ?? defaultReadFileSync;
  const unpaired: WorkerModePairing = { paired: false, enrolled: false, config: null };
  if (!existsSync(configPath)) {
    return unpaired;
  }

  // A parse failure throws rather than reporting "unpaired": the worker
  // rewrites this file in place (enrollment, advertised URLs), so a read can
  // land mid-write, and calling that "unpaired" is the very symptom this
  // status exists to rule out. Callers keep their last known state instead.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, ''));
  } catch {
    // Fixed message: JSON.parse errors quote a snippet of the file, which
    // holds the worker's credentials, and this message reaches logs and the UI.
    throw new Error('The worker config could not be read. It may be mid-save; try again shortly.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unpaired;
  }
  const raw = parsed as Record<string, unknown>;

  const coordinatorUrl = nonEmptyString(raw['coordinatorUrl'])
    ?? (Array.isArray(raw['coordinatorUrls'])
      ? raw['coordinatorUrls'].map(nonEmptyString).find((url): url is string => Boolean(url))
      : undefined);
  const nodeToken = nonEmptyString(raw['nodeToken']);
  const credential = nodeToken ?? nonEmptyString(raw['authToken']) ?? nonEmptyString(raw['token']);
  if (!coordinatorUrl || !credential) {
    return unpaired;
  }

  return {
    paired: true,
    enrolled: Boolean(nodeToken),
    config: {
      nodeId: nonEmptyString(raw['nodeId']) ?? '',
      name: nonEmptyString(raw['name']) ?? '',
      coordinatorUrl,
      namespace: nonEmptyString(raw['namespace']) ?? 'default',
      maxConcurrentInstances: typeof raw['maxConcurrentInstances'] === 'number'
        ? raw['maxConcurrentInstances']
        : 0,
      workingDirectories: Array.isArray(raw['workingDirectories'])
        ? raw['workingDirectories'].filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Stop the supervisor and the worker it launched. On POSIX the supervisor
 * forwards SIGTERM to its child. On Windows `kill()` is TerminateProcess on
 * the supervisor alone, which orphaned the real worker — it stayed connected
 * after "Stop Worker" and after Harness quit — so take the whole tree down.
 */
function defaultKillWorkerTree(child: ChildProcessLike): void {
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      timeout: 5000,
      windowsHide: true,
    });
    if (!result.error && result.status === 0) {
      return;
    }
  }
  child.kill('SIGTERM');
}

function buildWorkerRuntimeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || /token|secret|credential|password/i.test(key)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

function waitForChildExit(child: ChildProcessLike, fallbackMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(toGuidedServiceInstallError(fallbackMessage)));
    });
    child.once('error', (error) => reject(new Error(toGuidedServiceInstallError(error.message))));
    if (!child.pid) {
      reject(new Error(fallbackMessage));
    }
  });
}

function toGuidedServiceInstallError(message: string): string {
  if (/elevat|administrator|permission|denied|privilege/i.test(message)) {
    return 'Installing the background worker service needs administrator permission. Run Harness as administrator, or choose "Run while Harness is open" for this computer.';
  }
  return message;
}

export function resolveWorkerModeRuntimeCommand(
  options: ResolveWorkerModeRuntimeCommandOptions = {},
): WorkerModeRuntimeCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const suffix = platform === 'win32' ? '.exe' : '';
  const binaryName = `aio-worker${suffix}`;
  // Build candidate paths for the *target* platform, not the host. The function
  // is platform-injectable (used both at runtime and in cross-platform tests),
  // so path flavor must follow `platform` rather than the host separator.
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const resourcesPath = options.resourcesPath
    ?? (typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined);
  const cwd = options.cwd ?? process.cwd();

  const candidates = [
    env['AIO_WORKER_CLI_PATH'],
    resourcesPath ? pathApi.join(resourcesPath, 'worker-agent-cli', binaryName) : undefined,
    pathApi.resolve(cwd, 'dist', 'worker-agent-sea', binaryName),
    pathApi.resolve(cwd, 'dist', 'worker-agent-sea', `worker-agent${suffix}`),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const command = candidates.find((candidate) => existsSync(candidate));
  if (!command) {
    throw new Error(
      'Worker runtime binary was not found. Build worker-agent SEA assets or install the packaged Harness app.',
    );
  }

  return { command, args: [] };
}

let workerModeRuntimeService: WorkerModeRuntimeService | null = null;

export function getWorkerModeRuntimeService(): WorkerModeRuntimeService {
  workerModeRuntimeService ??= new WorkerModeRuntimeService();
  return workerModeRuntimeService;
}

export function _resetWorkerModeRuntimeServiceForTesting(): void {
  workerModeRuntimeService?.stop();
  workerModeRuntimeService = null;
}
