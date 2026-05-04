import type { BrowserTarget } from '@contracts/types/browser';

export class BrowserTargetRegistry {
  private static instance: BrowserTargetRegistry | null = null;
  private readonly targets = new Map<string, BrowserTarget>();

  static getInstance(): BrowserTargetRegistry {
    if (!this.instance) {
      this.instance = new BrowserTargetRegistry();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  upsertTarget(target: BrowserTarget): BrowserTarget {
    const next = { ...target };
    if (next.status === 'selected') {
      this.clearSelectedInProfile(next.profileId, next.id);
    }
    this.targets.set(next.id, next);
    return next;
  }

  listTargets(profileId?: string): BrowserTarget[] {
    return Array.from(this.targets.values()).filter(
      (target) => profileId === undefined || target.profileId === profileId,
    );
  }

  selectTarget(targetId: string): BrowserTarget {
    const target = this.targets.get(targetId);
    if (!target) {
      throw new Error(`Browser target ${targetId} not found`);
    }
    this.clearSelectedInProfile(target.profileId, target.id);
    const selected: BrowserTarget = {
      ...target,
      status: 'selected',
      lastSeenAt: Date.now(),
    };
    this.targets.set(targetId, selected);
    return selected;
  }

  markClosed(targetId: string): void {
    const target = this.targets.get(targetId);
    if (!target) {
      return;
    }
    this.targets.set(targetId, {
      ...target,
      status: 'closed',
      lastSeenAt: Date.now(),
    });
  }

  clearProfile(profileId: string): void {
    for (const target of this.targets.values()) {
      if (target.profileId === profileId) {
        this.targets.delete(target.id);
      }
    }
  }

  private clearSelectedInProfile(profileId: string | undefined, exceptId: string): void {
    for (const target of this.targets.values()) {
      if (
        target.id !== exceptId &&
        target.profileId === profileId &&
        target.status === 'selected'
      ) {
        this.targets.set(target.id, {
          ...target,
          status: 'available',
          lastSeenAt: Date.now(),
        });
      }
    }
  }
}

export function getBrowserTargetRegistry(): BrowserTargetRegistry {
  return BrowserTargetRegistry.getInstance();
}
