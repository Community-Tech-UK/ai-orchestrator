import { Injectable, computed, signal } from '@angular/core';
import { readStorage, writeStorage, type StorageField } from '../utils/typed-storage';
import { TIP_LIFETIME_CAP } from './tip-policy';

interface TipUsage { usedCounts: Record<string, number>; shownCounts: Record<string, number> }
function validCounts(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0);
}
const STORAGE: StorageField<TipUsage> = {
  key: 'working-tips:v1', version: 1, defaultValue: { usedCounts: {}, shownCounts: {} },
  validate: (value): value is TipUsage => {
    if (typeof value !== 'object' || value === null) return false;
    const data = value as Record<string, unknown>;
    return validCounts(data['usedCounts']) && validCounts(data['shownCounts']);
  },
};

@Injectable({ providedIn: 'root' })
export class FeatureUsageService {
  private readonly state = signal(readStorage(STORAGE));
  readonly usedCounts = computed(() => this.state().usedCounts);
  readonly shownCounts = computed(() => this.state().shownCounts);

  count(featureId: string): number {
    return Object.hasOwn(this.usedCounts(), featureId) ? this.usedCounts()[featureId] : 0;
  }
  record(featureId: string): void {
    this.update('usedCounts', featureId, Math.min(Number.MAX_SAFE_INTEGER, this.count(featureId) + 1));
  }
  markShown(tipId: string): void {
    const current = Object.hasOwn(this.shownCounts(), tipId) ? this.shownCounts()[tipId] : 0;
    this.update('shownCounts', tipId, Math.min(TIP_LIFETIME_CAP, current + 1));
  }
  retire(tipId: string): void { this.update('shownCounts', tipId, TIP_LIFETIME_CAP); }

  private update(kind: keyof TipUsage, id: string, count: number): void {
    const next = { ...this.state(), [kind]: { ...this.state()[kind], [id]: count } };
    this.state.set(next);
    writeStorage(STORAGE, next);
  }
}
