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
}

export function createIsolatedWorkerProcess<
  TInbound extends Serializable = Serializable,
  TOutbound = unknown,
>(
  options: IsolatedWorkerProcessOptions,
): IsolatedWorkerProcess<TInbound, TOutbound> {
  const child = fork(options.entrypoint, options.args ?? [], {
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
    execArgv: options.entrypoint.endsWith('.ts') ? ['--import', 'tsx'] : [],
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new ChildProcessWorkerHandle<TInbound, TOutbound>(options.name, child);
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
