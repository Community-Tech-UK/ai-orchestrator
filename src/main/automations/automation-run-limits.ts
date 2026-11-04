import { scheduleAutomationDeadline } from './automation-deadline-timer';
import { subscribeCostAttribution, type CostAttributionUsage } from '../core/system/cost-attribution';
import { AutomationStopAttempts } from './automation-stop-attempts';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationRun } from '../../shared/types/automation.types';
import { withRunLimits } from './automation-run-policy';
import { completionReceipt, isReceiptCurrent, type CompletionReceipt } from './automation-completion-receipts';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { AutomationDescendantSettlement } from './automation-descendant-settlement';

interface TrackedLimit {
  deadline: number;
  minutes: number;
  cap: number;
  processed: number;
  timer: () => void;
  members: Set<string>;
  runId: string;
  automationId: string;
  settled: Map<string, CompletionReceipt>;
  observedEvents: Set<string>;
  descendants: AutomationDescendantSettlement;
}
/** Run-wide limits stay live until terminalization, including descendants that finish first. */
export class AutomationRunLimits {
  private unsubscribeUsage: (() => void) | undefined;
  private readonly tracked = new Map<string, TrackedLimit>();
  private readonly stopping = new Map<string, TrackedLimit>();
  private readonly stops: AutomationStopAttempts;
  constructor(private readonly manager: Pick<InstanceManager, 'getInstance' | 'getAllInstances' | 'terminateInstance'> & Partial<Pick<InstanceManager, 'getAdapter'>>,
    private readonly now: () => number, private readonly stop: (rootId: string, reason: string) => void,
    private readonly recordUsage: (runId: string, instanceId: string, source: 'provider' | 'attributed', tokens: number) => number,
    reportStopFailure: (runId: string) => void, private readonly reconsider: (rootId: string) => void) {
    this.stops = new AutomationStopAttempts(id => {
      for (const limit of this.stopping.values()) if (limit.members.has(id)) reportStopFailure(limit.runId);
    });
  }

  track(rootId: string, run: AutomationRun): void {
    this.clear(rootId);
    const action = withRunLimits(run.configSnapshot!.action, run.configSnapshot!.schedule);
    const minutes = action.maxRunMinutes!;
    const deadline = (run.startedAt ?? this.now()) + minutes * 60_000;
    const timer = scheduleAutomationDeadline(deadline, this.now, () => { this.check(rootId); });
    const descendants = new AutomationDescendantSettlement(id => this.manager.getInstance(id), id => this.manager.getAdapter?.(id), (id, usage) => {
      const limit = this.tracked.get(rootId); if (!limit) return;
      if (!limit.settled.has(id)) this.addUsage(rootId, id, usage ?? {}, 'provider');
      limit.settled.set(id, {});
      if (!this.check(rootId)) this.reconsider(rootId);
    });
    this.tracked.set(rootId, { deadline, minutes, cap: action.maxProcessedTokens!, processed: run.processedTokens ?? 0, timer, members: new Set([rootId]), runId: run.id, automationId: run.automationId, settled: new Map(), observedEvents: new Set(), descendants });
    this.unsubscribeUsage ??= subscribeCostAttribution(record => {
      if (record.source !== 'instance-turn' || !record.instanceId || !record.usage) return;
      const root = this.rootFor(record.instanceId) ?? (record.parentId ? this.rootFor(record.parentId) : undefined);
      if (!root) return;
      (this.tracked.get(root) ?? this.stopping.get(root))?.members.add(record.instanceId);
      this.addUsage(root, record.instanceId, record.usage, 'attributed');
      // InstanceCommunication suppresses publication after removal, but its
      // settled accounting still carries captured lineage. This is a child
      // settlement receipt only; root success still requires normalized complete.
      if (record.instanceId !== root && !this.manager.getInstance(record.instanceId)) this.tracked.get(root)?.settled.set(record.instanceId, {});
      if (!this.check(root)) this.reconsider(root);
    });
  }
  /** Creation finished after dispatch already expired: own its stop and late usage, without another terminal event. */
  stopLateInstance(rootId: string, run: AutomationRun): void {
    this.track(rootId, run);
    const limit = this.tracked.get(rootId)!;
    for (const instance of this.manager.getAllInstances?.() ?? []) this.rootFor(instance.id);
    this.stopping.set(rootId, limit);
    this.clear(rootId);
    for (const id of [...limit.members].reverse()) this.requestStop(rootId, id);
  }

  rootFor(instanceId: string): string | undefined {
    for (const [rootId, limit] of [...this.tracked, ...this.stopping]) {
      if (limit.members.has(instanceId)) { if (instanceId !== rootId && this.tracked.has(rootId)) limit.descendants.watch(instanceId); return rootId; }
      let current = this.manager.getInstance?.(instanceId);
      const visited = new Set<string>();
      while (current?.parentId && !visited.has(current.id)) {
        visited.add(current.id);
        if (limit.members.has(current.parentId)) { limit.members.add(instanceId); if (this.tracked.has(rootId)) limit.descendants.watch(instanceId); return rootId; }
        current = this.manager.getInstance(current.parentId);
      }
    }
    return undefined;
  }
  observe(instanceId: string, envelope?: ProviderRuntimeEventEnvelope): string | undefined {
    const rootId = this.rootFor(instanceId);
    if (!rootId) return undefined;
    const usage = envelope?.event;
    const limit = (this.tracked.get(rootId) ?? this.stopping.get(rootId))!;
    limit.descendants.observeRemoval(instanceId);
    if (usage?.kind === 'complete' && (!envelope?.eventId || !limit.observedEvents.has(envelope.eventId))) {
      if (envelope?.eventId) limit.observedEvents.add(envelope.eventId);
      this.addUsage(rootId, instanceId, usage, 'provider');
      const receipt = completionReceipt(this.manager.getInstance(instanceId), envelope!);
      if (receipt) limit.settled.set(instanceId, receipt);
    }
    if (this.stopping.has(rootId)) { this.requestStop(rootId, instanceId); return rootId; }
    this.check(rootId);
    return rootId;
  }
  private addUsage(rootId: string, instanceId: string, usage: CostAttributionUsage & { tokensUsed?: number }, source: 'provider' | 'attributed'): void {
    const limit = this.tracked.get(rootId) ?? this.stopping.get(rootId);
    if (!limit) return;
    // Output is billed separately; the shared processed metric is input plus both caches.
    const counts = [usage.inputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
    const amount = counts.some(n => n !== undefined)
      ? counts.reduce<number>((sum, n) => sum + (Number.isFinite(n) && n! > 0 ? n! : 0), 0)
      : 0;
    if (amount > 0) limit.processed = this.recordUsage(limit.runId, instanceId, source, amount);
  }
  hasActiveDescendants(rootId: string): boolean {
    const live = this.manager.getAllInstances?.() ?? [];
    for (const instance of live) this.rootFor(instance.id);
    const limit = this.tracked.get(rootId);
    for (const id of limit?.members ?? []) limit?.descendants.observeRemoval(id);
    return !!limit && [...limit.members].some(id => id !== rootId
      && !isReceiptCurrent(limit.settled.get(id), this.manager.getInstance(id)));
  }
  check(rootId: string): boolean {
    const limit = this.tracked.get(rootId);
    if (!limit) return false;
    const reason = this.now() >= limit.deadline ? `Stopped after ${limit.minutes} minutes`
      : limit.processed > limit.cap ? 'Stopped: token cap' : undefined;
    if (!reason) return false;
    const descendants = this.manager.getAllInstances?.() ?? [];
    for (const instance of descendants) this.rootFor(instance.id);
    const ids = [...limit.members].reverse();
    this.stopping.set(rootId, limit);
    // Terminalize synchronously before cancellation emits completion/removed events.
    this.stop(rootId, reason);
    this.clear(rootId);
    for (const id of ids) this.requestStop(rootId, id);
    return true;
  }
  isStoppingAutomation(automationId: string): boolean { return [...this.stopping.values()].some(limit => limit.automationId === automationId); }
  removed(id: string): void {
    this.stops.acknowledgeRemoved(id);
    for (const [root, limit] of this.stopping) {
      limit.members.delete(id);
      if (!limit.members.size) this.stopping.delete(root);
    }
    this.releaseUsageIfUnused();
  }
  private requestStop(rootId: string, id: string): void {
    const limit = this.stopping.get(rootId); if (!limit) return;
    this.stops.request(id, async () => {
      const stopping = this.manager.terminateInstance(id, false);
      for (const instance of this.manager.getAllInstances?.() ?? []) this.rootFor(instance.id);
      for (const member of limit.members) if (member !== id && !this.stops.has(member)) this.requestStop(rootId, member);
      await stopping;
      limit.members.delete(id);
      if (!limit.members.size) this.stopping.delete(rootId);
      this.releaseUsageIfUnused();
    });
  }
  private releaseUsageIfUnused(): void {
    if (!this.tracked.size && !this.stopping.size) { this.unsubscribeUsage?.(); this.unsubscribeUsage = undefined; }
  }
  clear(rootId: string): void {
    const limit = this.tracked.get(rootId);
    if (limit) { limit.timer(); limit.descendants.clear(); }
    this.tracked.delete(rootId);
    this.releaseUsageIfUnused();
  }
}
