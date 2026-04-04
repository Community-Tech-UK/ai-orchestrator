import { getLogger } from '../logging/logger';

const logger = getLogger('ServerLifecycle');

export type ServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export class ServerLifecycle {
  private _state: ServerState = 'stopped';
  private _queue: Promise<void> = Promise.resolve();
  private readonly startFn: () => Promise<void>;
  private readonly stopFn: () => Promise<void>;

  constructor(startFn: () => Promise<void>, stopFn: () => Promise<void>) {
    this.startFn = startFn;
    this.stopFn = stopFn;
  }

  get state(): ServerState {
    return this._state;
  }

  async start(): Promise<void> {
    return this.enqueue(async () => {
      if (this._state === 'running') {
        logger.info('Server already running, ignoring start');
        return;
      }
      this._state = 'starting';
      try {
        await this.startFn();
        this._state = 'running';
        logger.info('Server started');
      } catch (err) {
        this._state = 'failed';
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
    this._queue = next.catch(() => {});
    return next;
  }
}
