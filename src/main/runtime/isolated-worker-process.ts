import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface IsolatedWorkerProcess<
  TInbound extends Serializable = Serializable,
  TOutbound = unknown,
> extends EventEmitter {
  postMessage(message: TInbound): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: TOutbound) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): this;
}

export interface IsolatedWorkerProcessOptions {
  name: string;
  entrypoint: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  /** Extra Node CLI flags for the worker (e.g. --max-old-space-size=512). */
  execArgv?: string[];
}

// -- Electron utilityProcess support ------------------------------------------
//
// Why this exists: the packaged app disables the `RunAsNode` Electron fuse
// (scripts/set-electron-fuses.js), which makes `ELECTRON_RUN_AS_NODE=1` a
// silent no-op. `child_process.fork()` always spawns `process.execPath`, so in
// a packaged build it boots a SECOND full Electron app instead of a Node
// interpreter. When that spawn originates from a helper process, the helper
// binary launches standalone, fails Electron's helper-path resolution, and
// dies with `FATAL: Unable to find helper app` (SIGTRAP) - the 2026-06 crash
// storm. Inside Electron we must therefore use `utilityProcess.fork()`, which
// is fuse-independent and purpose-built for Node workers in packaged apps.
//
// NOTE: `utilityProcess` only exists in the Electron MAIN process. Nested
// isolated workers (spawning from inside a worker) are NOT supported in
// packaged builds - the spawn-safety rule in scripts/check-import-boundaries.js
// enforces that no module reintroduces a fork/ELECTRON_RUN_AS_NODE spawn.

interface UtilityProcessLike extends NodeJS.EventEmitter {
  postMessage(message: unknown): void;
  kill(): boolean;
}

type UtilityProcessForkFn = (
  modulePath: string,
  args?: string[],
  options?: {
    serviceName?: string;
    env?: Record<string, string | undefined>;
    execArgv?: string[];
    stdio?: string;
  },
) => UtilityProcessLike;

/** Test seam: lets specs inject a fake `utilityProcess.fork`. */
export interface IsolatedWorkerRuntimeOverrides {
  utilityProcessFork?: UtilityProcessForkFn | null;
}

function resolveUtilityProcessFork(): UtilityProcessForkFn | null {
  // Plain Node (vitest, scripts) has no Electron; a process launched with a
  // working ELECTRON_RUN_AS_NODE (unfused dev binary) is Node-only too.
  if (!process.versions.electron || process.env['ELECTRON_RUN_AS_NODE']) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      utilityProcess?: { fork: UtilityProcessForkFn };
    };
    const utilityProcess = electron?.utilityProcess;
    return utilityProcess ? utilityProcess.fork.bind(utilityProcess) : null;
  } catch {
    return null;
  }
}

/**
 * `utilityProcess.fork` does not accept `ELECTRON_RUN_AS_NODE` in env, and we
 * never want to propagate it to children anyway: under the disabled fuse it is
 * misleading at best.
 */
function sanitizedEnv(
  extra?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env['ELECTRON_RUN_AS_NODE'];
  return env;
}

export function createIsolatedWorkerProcess<
  TInbound extends Serializable = Serializable,
  TOutbound = unknown,
>(
  options: IsolatedWorkerProcessOptions,
  overrides?: IsolatedWorkerRuntimeOverrides,
): IsolatedWorkerProcess<TInbound, TOutbound> {
  const utilityFork =
    overrides && 'utilityProcessFork' in overrides
      ? overrides.utilityProcessFork ?? null
      : resolveUtilityProcessFork();

  const execArgv = [
    ...(options.entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : []),
    ...(options.execArgv ?? []),
  ];

  if (utilityFork) {
    const child = utilityFork(options.entrypoint, options.args ?? [], {
      serviceName: options.name,
      env: sanitizedEnv(options.env),
      execArgv,
      stdio: 'inherit',
    });
    return new UtilityProcessWorkerHandle<TInbound, TOutbound>(options.name, child);
  }

  // Outside Electron, `process.execPath` is a real Node binary and fork()
  // behaves normally. (Under the unfused dev Electron binary the env var
  // still works, so this branch is also a safe fallback there.)
  const child = fork(options.entrypoint, options.args ?? [], {
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    execArgv,
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new ChildProcessWorkerHandle<TInbound, TOutbound>(options.name, child);
}

class UtilityProcessWorkerHandle<TInbound extends Serializable, TOutbound>
  extends EventEmitter
  implements IsolatedWorkerProcess<TInbound, TOutbound> {
  private exited = false;
  private exitCode: number | null = null;

  constructor(
    private readonly name: string,
    private readonly child: UtilityProcessLike,
  ) {
    super();
    child.on('message', (message: unknown) => this.emit('message', message as TOutbound));
    child.on('error', (error: Error) => this.emit('error', error));
    child.on('exit', (code: number | null) => {
      this.exited = true;
      this.exitCode = code ?? 0;
      this.emit('exit', code ?? 0, null);
    });
  }

  postMessage(message: TInbound): void {
    if (this.exited) {
      throw new Error(`${this.name} IPC is disconnected`);
    }
    this.child.postMessage(message);
  }

  async terminate(): Promise<number> {
    if (this.exited) {
      return this.exitCode ?? 0;
    }
    const exitPromise = new Promise<number>((resolve) => {
      this.child.once('exit', (code: number | null) => resolve(code ?? 0));
    });
    this.child.kill();
    // Don't let shutdown paths hang if the worker refuses to die.
    const timeout = new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(0), 3000);
      timer.unref?.();
    });
    return Promise.race([exitPromise, timeout]);
  }
}

class ChildProcessWorkerHandle<TInbound extends Serializable, TOutbound>
  extends EventEmitter
  implements IsolatedWorkerProcess<TInbound, TOutbound> {
  constructor(
    private readonly name: string,
    private readonly child: ChildProcess,
  ) {
    super();
    child.on('message', (message) => this.emit('message', message as TOutbound));
    child.on('error', (error) => this.emit('error', error));
    child.on('exit', (code, signal) => this.emit('exit', code, signal));
  }

  postMessage(message: TInbound): void {
    if (!this.child.connected) {
      throw new Error(`${this.name} IPC is disconnected`);
    }
    this.child.send(message);
  }

  async terminate(): Promise<number> {
    if (this.child.exitCode !== null) {
      return this.child.exitCode ?? 0;
    }
    this.child.kill();
    return 0;
  }
}
