import { spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';
import { existsSync as defaultExistsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
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

export interface WorkerModeRuntimeStatus {
  state: 'running' | 'stopped' | 'service-installed';
  pid?: number;
  command?: string;
  error?: string;
}

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

export interface WorkerModeRuntimeServiceOptions {
  spawn?: SpawnWorker;
  resolveCommand?: () => WorkerModeRuntimeCommand;
}

export class WorkerModeRuntimeService {
  private readonly spawn: SpawnWorker;
  private readonly resolveCommand: () => WorkerModeRuntimeCommand;
  private child: ChildProcessLike | null = null;
  private activeCommand: string | undefined;
  private lastError: string | undefined;

  constructor(options: WorkerModeRuntimeServiceOptions = {}) {
    this.spawn = options.spawn ?? defaultSpawn;
    this.resolveCommand = options.resolveCommand ?? (() => resolveWorkerModeRuntimeCommand());
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
      env: buildWorkerRuntimeEnv(),
    });
    this.child = child;
    this.activeCommand = resolved.command;
    this.lastError = undefined;

    child.once('exit', () => {
      if (this.child === child) {
        this.child = null;
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
    this.child?.kill('SIGTERM');
    this.child = null;
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
  const resourcesPath = options.resourcesPath
    ?? (typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined);
  const cwd = options.cwd ?? process.cwd();

  const candidates = [
    env['AIO_WORKER_CLI_PATH'],
    resourcesPath ? path.join(resourcesPath, 'worker-agent-cli', binaryName) : undefined,
    path.resolve(cwd, 'dist', 'worker-agent-sea', binaryName),
    path.resolve(cwd, 'dist', 'worker-agent-sea', `worker-agent${suffix}`),
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
