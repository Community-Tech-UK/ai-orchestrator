import { getLogger } from '../logging/logger';

const logger = getLogger('ServerLifecycle');

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';
export type ServerRunningConfig = Record<string, unknown>;

type StartFn<TConfig extends ServerRunningConfig | void = ServerRunningConfig | void> =
  () => Promise<TConfig>;
type StopFn = () => Promise<void>;

let lifecycleSingleton: ServerLifecycle | null = null;

export class ServerLifecycle<TConfig extends ServerRunningConfig | void = ServerRunningConfig | void> {
  private _state: ServerState = 'stopped';
  private _queue: Promise<void> = Promise.resolve();
  private readonly startFn: StartFn<TConfig>;
  private readonly stopFn: StopFn;
  private _runningConfig: Exclude<TConfig, void> | null = null;
  private _lastError: string | null = null;

  constructor(startFn: StartFn<TConfig>, stopFn: StopFn) {
    this.startFn = startFn;
    this.stopFn = stopFn;
  }

  get state(): ServerState {
    return this._state;
  }

  get runningConfig(): Exclude<TConfig, void> | null {
    return this._runningConfig;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this._state === 'running') {
        logger.info('Server already running, ignoring start');
        return;
      }
      this._state = 'starting';
      try {
        const startResult = await this.startFn();
        this._runningConfig = (startResult ?? null) as Exclude<TConfig, void> | null;
        this._lastError = null;
        this._state = 'running';
        logger.info('Server started');
      } catch (err) {
        this._state = 'failed';
        this._runningConfig = null;
        this._lastError = err instanceof Error ? err.message : String(err);
        logger.error('Server failed to start', err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    });
  }

  async stop(): Promise<void> {
    return this.enqueue(async () => {
      if (this._state === 'stopped') {
        return;
      }
      this._state = 'stopping';
      try {
        await this.stopFn();
      } finally {
        this._state = 'stopped';
        this._runningConfig = null;
        logger.info('Server stopped');
      }
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this._queue.then(fn, fn);
    this._queue = next.catch(() => undefined);
    return next;
  }
}

export function configureServerLifecycle(
  startFn: StartFn,
  stopFn: StopFn,
): ServerLifecycle {
  lifecycleSingleton = new ServerLifecycle(startFn, stopFn);
  return lifecycleSingleton;
}

export function getServerLifecycle(): ServerLifecycle {
  if (!lifecycleSingleton) {
    lifecycleSingleton = new ServerLifecycle(async () => undefined, async () => undefined);
  }
  return lifecycleSingleton;
}

export function _resetServerLifecycleForTesting(): void {
  lifecycleSingleton = null;
}
