import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';

/** One native send owns its error-event recovery, including errors from its retry. */
export class InstanceInputFailureScope {
  private identity: Pick<Instance, 'requestCount' | 'sessionId' | 'adapterGeneration' | 'provider'> | undefined;
  private recovery: Promise<boolean> | undefined;
  private closed = false;
  private retryDelivered = false;
  private cancel!: () => void;
  private readonly cancelled = new Promise<'cancelled'>(resolve => { this.cancel = () => resolve('cancelled'); });
  constructor(
    readonly instance: Instance,
    readonly adapter: CliAdapter,
    private readonly currentInstance: () => Instance | undefined,
    private readonly currentAdapter: () => CliAdapter | undefined,
    private readonly signal: AbortSignal | undefined,
    private readonly release: () => void,
  ) { signal?.addEventListener('abort', this.onAbort, { once: true }); }
  private readonly onAbort = (): void => { this.cancel(); };
  activate(): void {
    this.identity ??= { requestCount: this.instance.requestCount, sessionId: this.instance.sessionId,
      adapterGeneration: this.instance.adapterGeneration, provider: this.instance.provider };
  }
  get hasRecovery(): boolean { return this.recovery !== undefined; }
  get active(): boolean { return this.identity !== undefined && !this.closed; }
  isCurrent(): boolean {
    const current = this.currentInstance();
    return !this.closed && !this.signal?.aborted && current === this.instance && this.currentAdapter() === this.adapter
      && this.identity !== undefined && current.requestCount === this.identity.requestCount
      && current.sessionId === this.identity.sessionId && current.adapterGeneration === this.identity.adapterGeneration
      && current.provider === this.identity.provider;
  }
  markRetryDelivered(): void { if (this.isCurrent()) this.retryDelivered = true; }
  capture(work: () => Promise<boolean>): Promise<boolean> {
    if (this.recovery) return this.recovery;
    let resolve!: (handled: boolean) => void;
    let reject!: (error: unknown) => void;
    // Claim before invoking work: normalized events and notices can reenter the adapter.
    this.recovery = new Promise<boolean>((done, fail) => { resolve = done; reject = fail; });
    void this.recovery.catch(() => undefined);
    try { void work().then(resolve, reject); } catch (error) { reject(error); }
    return this.recovery;
  }
  async joinRejected(delivered: () => void): Promise<'handled' | 'failed' | undefined> {
    if (!this.recovery) return undefined;
    const handled = await Promise.race([this.recovery, this.cancelled]);
    if (handled === 'cancelled') return 'handled';
    if (this.retryDelivered && this.isCurrent()) delivered();
    return handled ? 'handled' : 'failed';
  }
  close(): void {
    this.closed = true;
    this.cancel();
    this.signal?.removeEventListener('abort', this.onAbort);
    this.release();
  }
}

/** Scoped to this communication manager; completed, removed and aborted sends release entries. */
export class InstanceInputFailureScopes {
  private readonly scopes = new Map<string, Set<InstanceInputFailureScope>>();
  constructor(
    private readonly getInstance: (id: string) => Instance | undefined,
    private readonly getAdapter: (id: string) => CliAdapter | undefined,
  ) {}
  open(instance: Instance, adapter: CliAdapter, signal?: AbortSignal): InstanceInputFailureScope {
    const entries = this.scopes.get(instance.id) ?? new Set<InstanceInputFailureScope>();
    this.scopes.set(instance.id, entries);
    const scope = new InstanceInputFailureScope(instance, adapter, () => this.getInstance(instance.id),
      () => this.getAdapter(instance.id), signal, () => {
        entries.delete(scope);
        if (entries.size === 0 && this.scopes.get(instance.id) === entries) this.scopes.delete(instance.id);
      });
    entries.add(scope);
    return scope;
  }
  find(instanceId: string, adapter: CliAdapter): InstanceInputFailureScope | undefined {
    // Queued sends are inactive until their actual admission callback runs.
    const active = [...this.scopes.get(instanceId) ?? []].filter(scope => scope.adapter === adapter && scope.active);
    return active.find(scope => scope.isCurrent()) ?? active[0];
  }
  cleanup(instanceId: string): void {
    for (const scope of this.scopes.get(instanceId) ?? []) scope.close();
    this.scopes.delete(instanceId);
  }
}
