import { markProviderDispatchNotStarted } from '../adapters/provider-dispatch-status';

/** Owns startup and teardown even when cancellation precedes the spawned event. */
export class CliWorkerProcessLifecycle {
  private terminating = false;
  private pendingSpawn: Promise<{ pid: number }> | undefined;

  async prepare<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { throw markProviderDispatchNotStarted(error instanceof Error ? error : new Error(String(error))); }
  }

  spawn(operation: () => Promise<{ pid: number }>): Promise<{ pid: number }> {
    if (this.terminating) return Promise.reject(markProviderDispatchNotStarted(new Error('Adapter terminated')));
    const pending = operation();
    this.pendingSpawn = pending;
    const clear = () => { if (this.pendingSpawn === pending) this.pendingSpawn = undefined; };
    void pending.then(clear, clear);
    return pending;
  }

  write(operation: () => Promise<void>): Promise<void> {
    if (this.terminating) return Promise.reject(markProviderDispatchNotStarted(new Error('Adapter terminated before provider dispatch')));
    return operation();
  }

  async terminate(operation: () => Promise<void>): Promise<void> {
    this.terminating = true;
    await this.pendingSpawn?.catch(() => undefined);
    await operation();
  }
}
