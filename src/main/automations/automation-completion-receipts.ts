import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import type { RunTracking } from './automation-runner-helpers';

export interface CompletionReceipt {
  requestCount?: number;
  adapterGeneration?: number;
  restartEpoch?: number;
}
export function completionReceipt(instance: Instance | undefined, envelope: ProviderRuntimeEventEnvelope): CompletionReceipt | undefined {
  if (!instance || envelope.event.kind !== 'complete') return undefined;
  if (instance?.requestCount !== envelope.event.requestCountAtCompletion) return undefined;
  if (envelope.adapterGeneration !== undefined && instance?.adapterGeneration !== envelope.adapterGeneration) return undefined;
  return { requestCount: envelope.event.requestCountAtCompletion, adapterGeneration: instance?.adapterGeneration, restartEpoch: instance?.restartEpoch };
}
export function isReceiptCurrent(receipt: CompletionReceipt | undefined, instance: Instance | undefined): boolean {
  return !!receipt && (!instance || (receipt.requestCount === instance.requestCount
    && receipt.adapterGeneration === instance.adapterGeneration && receipt.restartEpoch === instance.restartEpoch));
}

/** Only retain events carrying runtime-owned provenance for an active, newly spawning run. */
export class AutomationEarlyEvents {
  private readonly pending = new Map<string, ProviderRuntimeEventEnvelope[]>();
  discard(runId: string): void { this.pending.delete(runId); }
  retain(envelope: ProviderRuntimeEventEnvelope, instance: Instance | undefined, active: (runId: string) => boolean): void {
    const runId = instance?.metadata?.['automationRunId'];
    if (instance?.parentId || typeof runId !== 'string' || !active(runId)) return;
    const events = this.pending.get(runId) ?? [];
    events.push(envelope);
    this.pending.set(runId, events);
  }
  drain(runId: string, instanceId: string, consume: (envelope: ProviderRuntimeEventEnvelope) => void): void {
    const events = this.pending.get(runId) ?? [];
    this.pending.delete(runId);
    for (const event of events) if (event.instanceId === instanceId) consume(event);
  }
}

export function authorizeCompletion(tracking: RunTracking, instance: Instance | undefined, envelope: ProviderRuntimeEventEnvelope): void {
  const receipt = completionReceipt(instance, envelope);
  if (receipt) tracking.completionReceipt = receipt;
}
