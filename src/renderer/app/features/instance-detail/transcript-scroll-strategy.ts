/**
 * Variable-height virtual scroll strategy for the transcript.
 *
 * Maintains a height cache per item, defaulting to estimated heights
 * per item type. Heights are updated via ResizeObserver after render.
 */

import { Injectable } from '@angular/core';
import { distinctUntilChanged, Observable, Subject } from 'rxjs';
import type { VirtualScrollStrategy, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';

const DEFAULT_HEIGHTS: Record<string, number> = {
  message: 80,
  'tool-group': 120,
  'thought-group': 200,
};

@Injectable()
export class TranscriptScrollStrategy implements VirtualScrollStrategy {
  private viewport: CdkVirtualScrollViewport | null = null;
  private heightCache = new Map<number, number>();
  private scrolledIndexChange$ = new Subject<number>();

  scrolledIndexChange: Observable<number> = this.scrolledIndexChange$.pipe(distinctUntilChanged());

  attach(viewport: CdkVirtualScrollViewport): void {
    this.viewport = viewport;
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  detach(): void {
    this.viewport = null;
  }

  scrollToIndex(index: number, behavior: ScrollBehavior = 'auto'): void {
    if (!this.viewport) return;
    const offset = this.getOffsetForIndex(index);
    this.viewport.scrollToOffset(offset, behavior === 'smooth' ? 'smooth' : undefined);
  }

  onContentScrolled(): void {
    if (!this.viewport) return;
    this.updateRenderedRange();
  }

  onDataLengthChanged(): void {
    this.updateTotalContentSize();
    this.updateRenderedRange();
  }

  onContentRendered(): void {
    // No-op; heights updated via setItemHeight()
  }

  onRenderedOffsetChanged(): void {
    // No-op
  }

  /** Called by the component when ResizeObserver measures an item's actual height */
  setItemHeight(index: number, height: number): void {
    if (this.heightCache.get(index) !== height) {
      this.heightCache.set(index, height);
      this.updateTotalContentSize();
    }
  }

  /** Set the default height hint for an item based on its type */
  setItemTypeHint(index: number, type: string): void {
    if (!this.heightCache.has(index)) {
      const defaultHeight = DEFAULT_HEIGHTS[type] ?? DEFAULT_HEIGHTS['message'];
      this.heightCache.set(index, defaultHeight);
    }
  }

  private dataLength = 0;

  setDataLength(length: number): void {
    this.dataLength = length;
    this.onDataLengthChanged();
  }

  /** Clear height cache (e.g., on instance switch) */
  clearCache(): void {
    this.heightCache.clear();
    this.dataLength = 0;
  }

  private getItemHeight(index: number): number {
    return this.heightCache.get(index) ?? DEFAULT_HEIGHTS['message'];
  }

  private getOffsetForIndex(index: number): number {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += this.getItemHeight(i);
    }
    return offset;
  }

  private getIndexForOffset(offset: number): number {
    let accumulated = 0;
    for (let i = 0; i < this.dataLength; i++) {
      accumulated += this.getItemHeight(i);
      if (accumulated > offset) return i;
    }
    return Math.max(0, this.dataLength - 1);
  }

  private updateTotalContentSize(): void {
    if (!this.viewport) return;
    let totalSize = 0;
    for (let i = 0; i < this.dataLength; i++) {
      totalSize += this.getItemHeight(i);
    }
    this.viewport.setTotalContentSize(totalSize);
  }

  private updateRenderedRange(): void {
    if (!this.viewport) return;

    const scrollOffset = this.viewport.measureScrollOffset();
    const viewportSize = this.viewport.getViewportSize();
    const buffer = viewportSize; // Render one viewport of buffer above and below

    const startOffset = Math.max(0, scrollOffset - buffer);
    const endOffset = scrollOffset + viewportSize + buffer;

    const startIndex = this.getIndexForOffset(startOffset);
    const endIndex = Math.min(this.dataLength, this.getIndexForOffset(endOffset) + 1);

    this.viewport.setRenderedRange({ start: startIndex, end: endIndex });
    this.viewport.setRenderedContentOffset(this.getOffsetForIndex(startIndex));
    this.scrolledIndexChange$.next(startIndex);
  }
}
