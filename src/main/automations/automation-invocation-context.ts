import { randomUUID } from 'node:crypto';
import type { CliAdapter, UnifiedSpawnOptions } from '../cli/adapters/adapter-factory';

interface Invocation { rootId: string; runId: string; adapter?: CliAdapter }
/** Process-local registrations come from the scheduled loop dispatcher, never from RPC arguments. */
class AutomationInvocationContexts {
  private readonly roots = new Map<string, { runId: string; active: boolean }>();
  private readonly invocations = new Map<string, Invocation>();
  private readonly ownedAdapters = new Map<string, Set<CliAdapter>>();
  private config?: (callerId: string, provider: string) => string;
  configure(config: (callerId: string, provider: string) => string): void { this.config = config; }
  register(rootId: string, runId: string): void { this.roots.set(rootId, { runId, active: true }); }
  get(callerId: string): Readonly<Invocation> | undefined {
    const context = this.invocations.get(callerId);
    return context && this.roots.get(context.rootId)?.active ? context : undefined;
  }
  prepare(options: UnifiedSpawnOptions, provider: string): { options: UnifiedSpawnOptions; bind: (adapter: CliAdapter) => void; release: () => void } | undefined {
    const rootId = options.instanceId;
    const root = rootId ? this.roots.get(rootId) : undefined;
    if (!rootId || !root) return undefined;
    if (!root.active) throw new Error('Scheduled invocation has ended');
    if (!this.config) throw new Error('Scheduled invocation result tools are unavailable');
    const callerId = `automation-invocation:${randomUUID()}`;
    const context: Invocation = { rootId, runId: root.runId };
    this.invocations.set(callerId, context);
    const release = () => { this.invocations.delete(callerId); };
    let config: string;
    try { config = this.config(callerId, provider); } catch (error) { release(); throw error; }
    return {
      options: { ...options, mcpConfig: [...(options.mcpConfig ?? []), config] }, release,
      bind: adapter => {
        context.adapter = adapter;
        const owned = this.ownedAdapters.get(rootId) ?? new Set<CliAdapter>();
        owned.add(adapter); this.ownedAdapters.set(rootId, owned);
        const terminate = adapter.terminate.bind(adapter);
        adapter.terminate = async graceful => {
          release();
          await terminate(graceful);
          owned.delete(adapter);
          if (!owned.size) this.ownedAdapters.delete(rootId);
        };
      },
    };
  }
  revoke(rootId: string): void {
    const root = this.roots.get(rootId); if (root) root.active = false;
    for (const [id, context] of this.invocations) if (context.rootId === rootId) this.invocations.delete(id);
  }
  async stop(rootId: string): Promise<void> {
    this.revoke(rootId);
    const results = await Promise.allSettled([...(this.ownedAdapters.get(rootId) ?? [])].map(adapter => adapter.terminate(false)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
  reset(): void { this.roots.clear(); this.invocations.clear(); this.ownedAdapters.clear(); this.config = undefined; }
}
export const automationInvocations = new AutomationInvocationContexts();
