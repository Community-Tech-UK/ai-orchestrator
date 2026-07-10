/**
 * Transcript Jump Rail — Codex-style left-edge message navigator.
 *
 * Renders one tick per user message, positioned proportionally to where the
 * message sits in the transcript's scroll content, plus a viewport indicator.
 * Hovering a tick shows a prompt/reply preview card; clicking smooth-scrolls
 * the transcript to that message and flashes it (`jump-flash`, styled by the
 * parent). Hidden until the session has MIN_JUMP_TARGETS user messages and
 * actually overflows.
 *
 * The component only ever writes scrollTop via an explicit user click, using
 * the same programmatic-scroll shape as the scroll-to-top/bottom buttons, so
 * OutputScrollService's listener semantics (userScrolledUp, saved positions)
 * stay untouched.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { DisplayItem } from './display-item.types';
import {
  MIN_JUMP_TARGETS,
  activeMarkerIndex,
  collectJumpTargets,
  computeMarkerLayout,
} from './transcript-jump-rail.markers';

interface RailGeometry {
  /** offsetTop of each target's row, index-aligned with the targets. */
  anchorTops: number[];
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  railHeight: number;
}

const EMPTY_GEOMETRY: RailGeometry = {
  anchorTops: [],
  scrollHeight: 0,
  scrollTop: 0,
  clientHeight: 0,
  railHeight: 0,
};

const HOVER_SHOW_DELAY_MS = 120;
const JUMP_SCROLL_MARGIN = 12;
const PREVIEW_APPROX_HEIGHT = 96;

@Component({
  selector: 'app-transcript-jump-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.rail-visible]': 'visible()' },
  template: `
    @if (visible()) {
      <div class="rail" (mouseleave)="onRailLeave()">
        @if (hasOlderMessages()) {
          <button
            class="older-cap"
            (click)="loadOlder.emit()"
            title="Load earlier messages"
            aria-label="Load earlier messages"
          >⋯</button>
        }
        <div
          class="viewport-indicator"
          [style.top.px]="indicator().top"
          [style.height.px]="indicator().height"
        ></div>
        @for (marker of markers(); track marker.target.itemId; let i = $index) {
          <button
            class="tick"
            [class.active]="i === activeIndex()"
            [style.top.px]="marker.top"
            (mouseenter)="onTickEnter(i)"
            (click)="jumpTo(i)"
            [attr.aria-label]="'Jump to: ' + marker.target.promptExcerpt"
          ></button>
        }
        @if (hoverPreview(); as preview) {
          <div class="preview" [style.top.px]="preview.cardTop">
            <div class="preview-prompt">{{ preview.target.promptExcerpt }}</div>
            @if (preview.target.replyExcerpt) {
              <div class="preview-reply">{{ preview.target.replyExcerpt }}</div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      position: absolute;
      top: 12px;
      bottom: 12px;
      left: 0;
      width: 16px;
      display: block;
      z-index: 5;
      pointer-events: none;
    }

    .rail {
      position: relative;
      height: 100%;
      width: 100%;
      pointer-events: auto;
    }

    .viewport-indicator {
      position: absolute;
      left: 6px;
      width: 3px;
      border-radius: 2px;
      background: rgba(var(--primary-rgb), 0.12);
    }

    .tick {
      position: absolute;
      left: 3px;
      width: 9px;
      height: 3px;
      border-radius: 2px;
      border: none;
      padding: 0;
      margin-top: -1px;
      background: color-mix(in srgb, var(--text-muted) 45%, transparent);
      cursor: pointer;
      transition: background var(--transition-fast, 0.15s ease), width var(--transition-fast, 0.15s ease);
    }

    .rail:hover .tick {
      width: 12px;
      background: color-mix(in srgb, var(--text-muted) 70%, transparent);
    }

    .tick:hover,
    .tick.active {
      background: var(--primary-color);
    }

    .older-cap {
      position: absolute;
      top: -6px;
      left: 0;
      width: 16px;
      height: 14px;
      border: none;
      padding: 0;
      background: transparent;
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1;
      cursor: pointer;
    }

    .older-cap:hover {
      color: var(--text-primary);
    }

    .preview {
      position: absolute;
      left: 20px;
      width: 240px;
      padding: 8px 10px;
      border-radius: var(--radius-sm, 8px);
      background: color-mix(in srgb, var(--surface-color, #1a1d24) 92%, transparent);
      border: 1px solid rgba(var(--primary-rgb), 0.18);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(8px);
      pointer-events: none;
      z-index: 6;
    }

    .preview-prompt {
      color: var(--text-primary);
      font-size: 11px;
      line-height: 1.4;
    }

    .preview-reply {
      margin-top: 4px;
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.4;
    }
  `,
})
export class TranscriptJumpRailComponent {
  items = input.required<readonly DisplayItem[]>();
  viewport = input<HTMLElement | null>(null);
  hasOlderMessages = input(false);
  loadOlder = output<void>();

  private host = inject(ElementRef<HTMLElement>);
  private destroyRef = inject(DestroyRef);

  protected targets = computed(() => collectJumpTargets(this.items()));
  private geometry = signal<RailGeometry>(EMPTY_GEOMETRY);
  protected hoveredIndex = signal(-1);

  protected visible = computed(() => {
    const g = this.geometry();
    return this.targets().length >= MIN_JUMP_TARGETS && g.scrollHeight > g.clientHeight + 1;
  });

  protected markers = computed(() => {
    const g = this.geometry();
    const targets = this.targets();
    // A stale measurement (targets changed since the last measure pass) is
    // index-misaligned; render nothing until the scheduled re-measure lands.
    if (g.scrollHeight <= 0 || g.anchorTops.length !== targets.length) return [];
    const ratios = g.anchorTops.map((top) => Math.max(0, top) / g.scrollHeight);
    const tops = computeMarkerLayout(ratios, g.railHeight);
    return targets.map((target, i) => ({ target, top: tops[i] }));
  });

  protected activeIndex = computed(() => {
    const g = this.geometry();
    if (g.anchorTops.length !== this.targets().length) return -1;
    return activeMarkerIndex(g.anchorTops, g.scrollTop, g.clientHeight);
  });

  protected indicator = computed(() => {
    const g = this.geometry();
    if (g.scrollHeight <= 0 || g.railHeight <= 0) return { top: 0, height: 0 };
    const height = Math.max(12, (g.clientHeight / g.scrollHeight) * g.railHeight);
    const maxTop = Math.max(0, g.railHeight - height);
    const scrollable = g.scrollHeight - g.clientHeight;
    const top = scrollable > 0 ? (g.scrollTop / scrollable) * maxTop : 0;
    return { top: Math.max(0, Math.min(maxTop, top)), height };
  });

  protected hoverPreview = computed(() => {
    const index = this.hoveredIndex();
    const marker = this.markers()[index];
    if (index < 0 || !marker) return null;
    const railHeight = this.geometry().railHeight;
    const cardTop = Math.max(0, Math.min(marker.top - 12, railHeight - PREVIEW_APPROX_HEIGHT));
    return { target: marker.target, cardTop };
  });

  private measureScheduled = false;
  private hoverTimer: number | null = null;

  constructor() {
    // Re-measure whenever the rendered items or the viewport element change.
    // visibleItems() upstream is reference-stabilised, so this fires only on
    // real content changes (including streaming growth, which replaces the
    // affected item references).
    effect(() => {
      this.items();
      this.viewport();
      this.scheduleMeasure();
    });

    // Visibility flipping toggles the transcript's left padding (parent CSS),
    // which reflows content without resizing the viewport box — re-measure.
    effect(() => {
      this.visible();
      this.scheduleMeasure();
    });

    // Viewport listeners: scroll drives the indicator/active tick (and cheaply
    // refreshes anchor offsets); ResizeObserver catches panel/window resizes.
    effect((onCleanup) => {
      const vp = this.viewport();
      if (!vp) return;
      const onScroll = (): void => this.scheduleMeasure();
      vp.addEventListener('scroll', onScroll, { passive: true });
      let resizeObserver: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => this.scheduleMeasure());
        resizeObserver.observe(vp);
      }
      onCleanup(() => {
        vp.removeEventListener('scroll', onScroll);
        resizeObserver?.disconnect();
      });
    });

    this.destroyRef.onDestroy(() => this.clearHoverTimer());
  }

  protected jumpTo(index: number): void {
    const vp = this.viewport();
    const target = this.targets()[index];
    if (!vp || !target) return;
    const row = this.findRow(vp, target.itemId);
    if (!row) return;

    vp.scrollTo({ top: Math.max(0, row.offsetTop - JUMP_SCROLL_MARGIN), behavior: 'smooth' });
    row.classList.add('jump-flash');
    row.addEventListener('animationend', () => row.classList.remove('jump-flash'), { once: true });
  }

  protected onTickEnter(index: number): void {
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.hoveredIndex.set(index);
      this.hoverTimer = null;
    }, HOVER_SHOW_DELAY_MS);
  }

  protected onRailLeave(): void {
    this.clearHoverTimer();
    this.hoveredIndex.set(-1);
  }

  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
  }

  private scheduleMeasure(): void {
    if (this.measureScheduled) return;
    this.measureScheduled = true;
    requestAnimationFrame(() => {
      this.measureScheduled = false;
      this.measure();
    });
  }

  /**
   * Read all rail geometry in one pass: anchor offsets (offsetTop is relative
   * to the scroll container, its nearest positioned ancestor), scroll metrics,
   * and the rail's own height. O(user messages) layout reads, no writes.
   */
  private measure(): void {
    const vp = this.viewport();
    if (!vp) {
      this.geometry.set(EMPTY_GEOMETRY);
      return;
    }
    const anchorTops = this.targets().map(
      (target) => this.findRow(vp, target.itemId)?.offsetTop ?? 0,
    );
    this.geometry.set({
      anchorTops,
      scrollHeight: vp.scrollHeight,
      scrollTop: vp.scrollTop,
      clientHeight: vp.clientHeight,
      railHeight: (this.host.nativeElement as HTMLElement).clientHeight,
    });
  }

  private findRow(vp: HTMLElement, itemId: string): HTMLElement | null {
    const escaped =
      typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(itemId)
        : itemId.replace(/"/g, '\\"');
    return vp.querySelector<HTMLElement>(`[data-item-id="${escaped}"]`);
  }
}
