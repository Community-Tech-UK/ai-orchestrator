import type { LoopState } from '../../shared/types/loop.types';
import type { LoopChildResult } from './loop-coordinator.types';
import { LOOP_COLD_CACHE_IDLE_MS, LOOP_COLD_CACHE_MIN_TOKENS } from './loop-context-survival';

/** Last settled, owned context only. Restores have no resident adapter to recycle. */
export class LoopColdCacheTracker {
  private readonly samples = new WeakMap<LoopState, { used: number; endedAt: number }>();

  record(state: LoopState, result: LoopChildResult, endedAt: number): void {
    this.samples.delete(state);
    const used = result.contextOccupancy?.used;
    const total = result.contextOccupancy?.total;
    if (state.config.provider !== 'claude' || result.transcriptBound !== false || result.contextCompacted
      || typeof used !== 'number' || !Number.isFinite(used) || used < LOOP_COLD_CACHE_MIN_TOKENS
      || typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || !Number.isFinite(endedAt)) return;
    this.samples.set(state, { used, endedAt });
  }

  consumeResetReason(state: LoopState, now = Date.now()): string | null {
    const sample = this.samples.get(state);
    if (!sample || state.config.provider !== 'claude'
      || (state.config.contextStrategy ?? 'same-session') !== 'same-session'
      || state.config.context?.compaction.enabled === false
      || !Number.isFinite(now) || now - sample.endedAt <= LOOP_COLD_CACHE_IDLE_MS) return null;
    this.samples.delete(state);
    return `idle ${Math.round((now - sample.endedAt) / 60_000)}m exceeds the cache lifetime and the context is `
      + `${Math.round(sample.used / 1_000)}K; starting a fresh session is cheaper than re-writing it`;
  }
}
