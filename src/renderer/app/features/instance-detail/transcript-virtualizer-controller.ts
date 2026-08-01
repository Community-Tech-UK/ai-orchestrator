import { computed, signal } from '@angular/core';
import {
  captureAnchor,
  computeRenderSegments,
  estimateTotalHeight,
  resolveAnchorScrollTop,
  type RenderSegment,
  type TranscriptAnchor,
} from './transcript-virtualizer-math';
import { TranscriptHeightCache } from './transcript-virtualizer-height-cache';

export interface TranscriptVirtualizerDeps<T extends { id: string }> {
  getViewportElement: () => HTMLElement | null;
  getInstanceId: () => string;
  getItems: () => readonly T[];
  /** The `transcriptVirtualization` setting. */
  enabled: () => boolean;
  /** True while something (e.g. an open find search) needs every loaded item
   *  in the DOM regardless of scroll position. */
  bypass: () => boolean;
  /** Rows that must stay rendered even when scrolled out of the window —
   *  today: top-level user messages, which the jump rail and inline-edit
   *  focus both need to `querySelector` synchronously. */
  isPinned: (item: T) => boolean;
  /** Mirrors the component's existing `userScrolledUpRef`: true once the
   *  user has scrolled away from the bottom. */
  isScrolledUp: () => boolean;
}

/**
 * Angular-facing half of WS-C10 transcript virtualization: owns the
 * reactive scrollTop/viewportHeight/height-revision signals, the per-row
 * ResizeObserver, the viewport scroll/resize listeners, and per-session
 * anchor memory. All positional math is delegated to
 * `transcript-virtualizer-math.ts`; this class is the DOM glue and is
 * exercised with jsdom in its spec, not real-browser layout.
 */
export class TranscriptVirtualizerController<T extends { id: string }> {
  readonly heightCache = new TranscriptHeightCache();

  private readonly scrollTop = signal(0);
  private readonly viewportHeight = signal(0);
  private readonly heightRevision = signal(0);
  private readonly sessionAnchors = new Map<string, TranscriptAnchor>();
  private readonly observedRows = new Map<string, Element>();
  private rowResizeObserver: ResizeObserver | null = null;

  constructor(private readonly deps: TranscriptVirtualizerDeps<T>) {}

  /** Segments to render: a mix of real rows and collapsed-region spacers,
   *  in item order. Falls back to "every item is a row" (identical to the
   *  non-virtualized path) when disabled or bypassed. */
  readonly segments = computed<RenderSegment<T>[]>(() => {
    // Establish reactive dependencies before any early return, so a later
    // toggle of `enabled`/`bypass` while scrolled still recomputes.
    const scrollTopValue = this.scrollTop();
    const viewportHeightValue = this.viewportHeight();
    this.heightRevision();

    const items = this.deps.getItems();
    if (!this.deps.enabled() || this.deps.bypass()) {
      return items.map((item) => ({ type: 'row' as const, id: item.id, item }));
    }

    const instanceId = this.deps.getInstanceId();
    const heightOf = this.heightCache.boundHeightOf(instanceId);
    const getId = (item: T): string => item.id;

    const effectiveScrollTop = this.deps.isScrolledUp()
      ? scrollTopValue
      : Math.max(0, estimateTotalHeight(items, heightOf, getId) - viewportHeightValue);

    return computeRenderSegments(items, {
      scrollTop: effectiveScrollTop,
      viewportHeight: viewportHeightValue,
      heightOf,
      isPinned: this.deps.isPinned,
      getId,
    });
  });

  /** Attaches the viewport scroll listener + a ResizeObserver watching for
   *  viewport-size changes (panel resize, window resize). Returns a cleanup
   *  function; call it (e.g. from `DestroyRef.onDestroy`) to detach
   *  everything, including per-row observers. */
  attach(): () => void {
    const vp = this.deps.getViewportElement();
    if (!vp) {
      // No viewport yet (component rendered without the scroll container):
      // nothing was attached, so cleanup is a no-op.
      return () => undefined;
    }

    this.recordViewportState();
    const onScroll = (): void => this.recordViewportState();
    vp.addEventListener('scroll', onScroll, { passive: true });

    let viewportResizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      viewportResizeObserver = new ResizeObserver(() => this.recordViewportState());
      viewportResizeObserver.observe(vp);
    }

    return () => {
      vp.removeEventListener('scroll', onScroll);
      viewportResizeObserver?.disconnect();
      this.rowResizeObserver?.disconnect();
      this.rowResizeObserver = null;
      this.observedRows.clear();
    };
  }

  /** Re-reads scrollTop/clientHeight from the live viewport. Called by the
   *  scroll/resize listeners set up in `attach()`; exposed so a caller can
   *  force a re-read (e.g. right after a programmatic scroll). */
  recordViewportState(): void {
    const vp = this.deps.getViewportElement();
    if (!vp) return;
    this.scrollTop.set(vp.scrollTop);
    this.viewportHeight.set(vp.clientHeight);
  }

  /**
   * Diffs the rows currently in the DOM (`.transcript-item[data-item-id]`)
   * against the previously observed set, observing new rows and
   * unobserving ones that scrolled out of the window. Call this from a
   * component effect keyed on `segments()`, after Angular has patched the
   * DOM for the new segment list.
   */
  reconcileObservedRows(): void {
    const vp = this.deps.getViewportElement();
    if (!vp) return;
    if (!this.rowResizeObserver && typeof ResizeObserver !== 'undefined') {
      this.rowResizeObserver = new ResizeObserver((entries) => this.onRowsResized(entries));
    }
    const observer = this.rowResizeObserver;
    if (!observer) return;

    const seen = new Set<string>();
    const rows = Array.from(vp.querySelectorAll<HTMLElement>('.transcript-item[data-item-id]'));
    for (const row of rows) {
      const id = row.getAttribute('data-item-id');
      if (!id) continue;
      seen.add(id);
      if (!this.observedRows.has(id)) {
        this.observedRows.set(id, row);
        observer.observe(row);
      }
    }
    for (const [id, el] of Array.from(this.observedRows.entries())) {
      if (!seen.has(id)) {
        observer.unobserve(el);
        this.observedRows.delete(id);
      }
    }
  }

  private onRowsResized(entries: ResizeObserverEntry[]): void {
    const instanceId = this.deps.getInstanceId();
    let changed = false;
    for (const entry of entries) {
      const id = (entry.target as HTMLElement).getAttribute('data-item-id');
      if (!id) continue;
      const height = entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height;
      const previous = this.heightCache.get(instanceId, id);
      this.heightCache.set(instanceId, id, height);
      if (Math.abs(previous - height) > 0.5) changed = true;
    }
    if (changed) this.heightRevision.update((v) => v + 1);
  }

  /**
   * Force-renders `id` by computing the scrollTop that places it at the
   * viewport top and applying it — both to the reactive `scrollTop` signal
   * (so `segments()` includes it on the next read) and to the live
   * viewport's `scrollTop` (so a synchronous DOM query for the row right
   * after this call has a real, if not-yet-final, position to work with).
   * Returns the resolved scrollTop, or null when `id` isn't in the loaded
   * item list at all.
   */
  scrollToId(id: string): number | null {
    const vp = this.deps.getViewportElement();
    if (!vp) return null;
    const instanceId = this.deps.getInstanceId();
    const target = resolveAnchorScrollTop(
      { id, offset: 0 },
      this.deps.getItems(),
      this.heightCache.boundHeightOf(instanceId),
      (item) => item.id,
    );
    if (target === null) return null;
    this.scrollTop.set(target);
    vp.scrollTop = target;
    return target;
  }

  /** Captures the topmost fully-visible rendered row as `instanceId`'s
   *  anchor, for restoration next time that session is switched to. */
  saveAnchorForInstance(instanceId: string): void {
    const vp = this.deps.getViewportElement();
    if (!vp) return;
    const scrollTopValue = vp.scrollTop;
    const rows = Array.from(vp.querySelectorAll<HTMLElement>('.transcript-item[data-item-id]'))
      .map((el) => ({
        id: el.getAttribute('data-item-id') ?? '',
        top: el.offsetTop - scrollTopValue,
        height: el.offsetHeight,
      }))
      .filter((row) => row.id !== '');
    const anchor = captureAnchor(rows, vp.clientHeight);
    if (anchor) this.sessionAnchors.set(instanceId, anchor);
  }

  /** Resolves `instanceId`'s saved anchor (if any) against its current
   *  loaded items and height cache. Null when there is no saved anchor or
   *  its message has since dropped out of the loaded set. */
  restoreScrollTopForInstance(instanceId: string): number | null {
    const anchor = this.sessionAnchors.get(instanceId);
    if (!anchor) return null;
    return resolveAnchorScrollTop(
      anchor,
      this.deps.getItems(),
      this.heightCache.boundHeightOf(instanceId),
      (item) => item.id,
    );
  }

  /** Sets the scrollTop signal directly, without reading the live viewport
   *  — used right before a programmatic scroll restore, so `segments()`
   *  already reflects the target window when the DOM patches in. */
  recordScrollTopValue(value: number): void {
    this.scrollTop.set(Math.max(0, value));
  }
}
