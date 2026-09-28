import type { ContextUsage } from '../../shared/types/instance.types';

type UsageSnapshot = { percentage: number };
type TrackedUsageSnapshot = { adapterGeneration?: number; usage: UsageSnapshot };

export interface ProviderCompactionUsageBoundary {
  previousUsage?: UsageSnapshot;
  newUsage?: UsageSnapshot;
}

/** Correlates the last measured usage before compaction with its later boundary output. */
export class ProviderCompactionUsageTracker {
  private readonly previousByInstance = new Map<string, TrackedUsageSnapshot>();

  started(instanceId: string, adapterGeneration: number | undefined, usage: ContextUsage | undefined): void {
    const snapshot = this.snapshot(usage);
    if (snapshot) this.previousByInstance.set(instanceId, { adapterGeneration, usage: snapshot });
    else this.previousByInstance.delete(instanceId);
  }

  consumeBoundary(
    instanceId: string,
    adapterGeneration: number | undefined,
    usage: ContextUsage | undefined,
  ): ProviderCompactionUsageBoundary {
    const tracked = this.previousByInstance.get(instanceId);
    this.previousByInstance.delete(instanceId);
    const previousUsage = tracked && tracked.adapterGeneration === adapterGeneration
      ? tracked.usage
      : undefined;
    const currentUsage = this.snapshot(usage);
    const newUsage = previousUsage && currentUsage?.percentage !== previousUsage.percentage
      ? currentUsage
      : undefined;
    return {
      ...(previousUsage ? { previousUsage } : {}),
      ...(newUsage ? { newUsage } : {}),
    };
  }

  forget(instanceId: string): void {
    this.previousByInstance.delete(instanceId);
  }

  private snapshot(usage: ContextUsage | undefined): UsageSnapshot | undefined {
    return usage && !usage.isEstimated && usage.total > 0 && Number.isFinite(usage.percentage)
      ? { percentage: usage.percentage }
      : undefined;
  }
}
