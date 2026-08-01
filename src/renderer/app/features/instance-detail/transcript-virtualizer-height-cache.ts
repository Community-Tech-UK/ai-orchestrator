import { DEFAULT_ESTIMATED_ROW_HEIGHT_PX } from './transcript-virtualizer-math';

/**
 * Per-session measured-row-height cache for WS-C10 transcript virtualization.
 *
 * Keyed by `(instanceId, itemId)`. Measurements persist across session
 * switches (that's the point of a *per-session* cache — returning to a
 * session should not re-estimate rows it already measured), and are only
 * ever removed via explicit `invalidate()` (collapse/expand correctness) —
 * there is no size-based eviction in this v1 prototype; a full transcript's
 * worth of numbers per open session is negligible next to the transcript
 * content itself.
 */
export class TranscriptHeightCache {
  private readonly bySession = new Map<string, Map<string, number>>();

  /** Measured or estimated height for `itemId` in `instanceId`. */
  get(instanceId: string, itemId: string): number {
    return this.bySession.get(instanceId)?.get(itemId) ?? DEFAULT_ESTIMATED_ROW_HEIGHT_PX;
  }

  has(instanceId: string, itemId: string): boolean {
    return this.bySession.get(instanceId)?.has(itemId) ?? false;
  }

  /** Records a real measurement. Ignores non-finite/non-positive values
   *  (e.g. a row measured mid-layout-thrash) so a bad reading can't poison
   *  the cache. */
  set(instanceId: string, itemId: string, height: number): void {
    if (!Number.isFinite(height) || height <= 0) return;
    let session = this.bySession.get(instanceId);
    if (!session) {
      session = new Map<string, number>();
      this.bySession.set(instanceId, session);
    }
    session.set(itemId, height);
  }

  /** Drops a measurement, forcing the next layout pass to use the estimate
   *  again until a fresh ResizeObserver callback re-measures it. */
  invalidate(instanceId: string, itemId: string): void {
    this.bySession.get(instanceId)?.delete(itemId);
  }

  /** Bind a `heightOf` accessor for a fixed instance — the shape
   *  `transcript-virtualizer-math.ts` functions expect. */
  boundHeightOf(instanceId: string): (itemId: string) => number {
    return (itemId) => this.get(instanceId, itemId);
  }
}
