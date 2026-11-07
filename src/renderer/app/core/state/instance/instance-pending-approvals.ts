import type { Instance } from './instance.types';

/** Session/request identities prevent duplicate and late replies changing another approval. */
export class InstancePendingApprovals {
  private readonly requests = new Map<string, Set<string>>();

  add(instance: Instance, requestId: string, type: unknown): number | undefined {
    if (instance.yoloMode || (type !== 'permission_denial' && type !== 'deferred_permission'
      && type !== 'codex_mcp_approval' && type !== 'acp_permission_request')) return;
    const pending = (instance.pendingApprovalCount ?? 0) > 0
      ? this.requests.get(instance.id) ?? new Set<string>() : new Set<string>();
    if (pending.has(requestId)) return;
    pending.add(requestId);
    this.requests.set(instance.id, pending);
    return pending.size;
  }

  settle(instanceId: string, instance: Instance | undefined, requestId: string): number | undefined {
    if (!instance || !(instance.pendingApprovalCount ?? 0)) {
      this.requests.delete(instanceId);
      return;
    }
    const pending = this.requests.get(instance.id);
    if (!pending?.delete(requestId)) return;
    if (pending.size === 0) this.requests.delete(instance.id);
    return pending.size;
  }

  clear(instanceId: string): void { this.requests.delete(instanceId); }
  clearAll(): void { this.requests.clear(); }
}
