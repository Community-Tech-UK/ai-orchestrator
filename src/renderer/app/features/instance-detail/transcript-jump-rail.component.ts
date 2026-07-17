/**
 * Transcript Jump Rail — Codex-style left-edge message navigator.
 *
 * Renders one thin tick line per user prompt in the SESSION (the
 * sessionPrompts tally — not just the loaded window) as a tight, evenly
 * spaced cluster bunched at the vertical centre of the rail (Codex-style —
 * not spread across the full pane height). The tick for the turn currently
 * in view is longer and brighter (Codex's "you are here" mark).
 * Hovering a tick shows a preview card — prompt excerpt, reply excerpt, and
 * chips for files edited during that turn; clicking smooth-scrolls the
 * transcript to that message and flashes it (`jump-flash`, styled by the
 * parent). Clicking a tick whose message is outside the rendered window
 * keeps loading older pages until it arrives, then jumps. Hidden until the
 * transcript overflows (or has older messages) and the session has
 * MIN_JUMP_TARGETS prompts — or one, when older messages exist.
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
import type { UserPromptRef } from '../../../../shared/types/prompt-index.types';
import {
  MIN_JUMP_TARGETS,
  activeMarkerIndex,
  collectJumpTargets,
  computeMarkerLayout,
  mergeSessionTicks,
  type JumpTarget,
} from './transcript-jump-rail.markers';

interface RailGeometry {
  /** offsetTop of each tick's row, index-aligned with ticks; NaN when unloaded. */
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
const PREVIEW_APPROX_HEIGHT = 132;
const MAX_PREVIEW_FILE_CHIPS = 2;
/** Older-load rounds a stub-tick jump may request before giving up. */
const MAX_PENDING_JUMP_LOADS = 40;

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
        @for (marker of markers(); track marker.tick.messageId; let i = $index) {
          <button
            class="tick"
            [class.active]="i === activeIndex()"
            [style.top.px]="marker.top"
            (mouseenter)="onTickEnter(i)"
            (click)="jumpTo(i)"
            [attr.aria-label]="'Jump to: ' + marker.tick.promptExcerpt"
          ></button>
        }
        @if (hoverPreview(); as preview) {
          <div class="preview" [style.top.px]="preview.cardTop">
            <div class="preview-prompt">{{ preview.tick.promptExcerpt }}</div>
            @if (preview.tick.target?.replyExcerpt) {
              <div class="preview-reply">{{ preview.tick.target?.replyExcerpt }}</div>
            }
            @if (!preview.tick.target) {
              <div class="preview-hint">Click to load this message</div>
            }
            @if (preview.chips.length > 0) {
              <div class="preview-files">
                @for (file of preview.chips; track file) {
                  <span class="file-chip">
                    <svg class="chip-icon" viewBox="0 0 12 12" aria-hidden="true">
                      <path d="M3 1h4l3 3v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                      <path d="M7 1v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>
                    </svg>
                    <span class="chip-name">{{ file }}</span>
                  </span>
                }
                @if (preview.moreCount > 0) {
                  <span class="file-chip more">+{{ preview.moreCount }}</span>
                }
              </div>
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
      width: 20px;
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

    /* Codex-style tick: the button is an enlarged hit target; the visible
       line is drawn by ::after so ticks stay thin without being unclickable. */
    .tick {
      position: absolute;
      left: 0;
      width: 20px;
      height: 7px;
      margin-top: -3.5px;
      border: none;
      padding: 0;
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
    }

    .tick::after {
      content: '';
      display: block;
      width: 10px;
      height: 2px;
      border-radius: 1px;
      background: color-mix(in srgb, var(--text-muted) 40%, transparent);
      transition: background var(--transition-fast, 0.15s ease), width var(--transition-fast, 0.15s ease);
    }

    .rail:hover .tick::after {
      background: color-mix(in srgb, var(--text-muted) 65%, transparent);
    }

    .tick.active::after {
      width: 18px;
      background: var(--text-primary);
    }

    .tick:hover::after {
      width: 18px;
      background: var(--text-primary);
    }

    .older-cap {
      position: absolute;
      top: -6px;
      left: 0;
      width: 20px;
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
      left: 24px;
      width: 280px;
      padding: 10px 12px;
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface-color, #1a1d24) 94%, transparent);
      border: 1px solid color-mix(in srgb, var(--text-muted) 22%, transparent);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      pointer-events: none;
      z-index: 6;
    }

    .preview-prompt {
      color: var(--text-primary);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .preview-reply {
      margin-top: 5px;
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.4;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }

    .preview-hint {
      margin-top: 5px;
      color: var(--text-muted);
      font-size: 10px;
      font-style: italic;
    }

    .preview-files {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 8px;
      overflow: hidden;
    }

    .file-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      padding: 2px 7px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--text-muted) 12%, transparent);
      color: var(--text-muted);
      font-size: 10px;
      line-height: 1.5;
      white-space: nowrap;
    }

    .file-chip.more {
      flex-shrink: 0;
    }

    .chip-icon {
      width: 10px;
      height: 10px;
      flex-shrink: 0;
    }

    .chip-name {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 110px;
    }
  `,
})
export class TranscriptJumpRailComponent {
  items = input.required<readonly DisplayItem[]>();
  viewport = input<HTMLElement | null>(null);
  hasOlderMessages = input(false);
  /** Full session prompt tally (see UserPromptRef) — may exceed the loaded window. */
  sessionPrompts = input<readonly UserPromptRef[]>([]);
  loadOlder = output<void>();

  private host = inject(ElementRef<HTMLElement>);
  private destroyRef = inject(DestroyRef);

  protected targets = computed(() => collectJumpTargets(this.items()));
  /** One tick per session prompt; carries the loaded target when in-window. */
  protected ticks = computed(() => mergeSessionTicks(this.sessionPrompts(), this.targets()));
  private geometry = signal<RailGeometry>(EMPTY_GEOMETRY);
  protected hoveredIndex = signal(-1);
  /** Stub-tick click in flight: keep loading older until this prompt arrives. */
  private pendingJumpMessageId = signal<string | null>(null);
  private pendingJumpLoads = 0;

  protected visible = computed(() => {
    const g = this.geometry();
    const hasOlder = this.hasOlderMessages();
    if (g.scrollHeight <= g.clientHeight + 1 && !hasOlder) return false;
    const count = this.ticks().length;
    // A bounded message window can hold few prompts even in a long session;
    // when older messages exist there is more transcript to navigate to, so
    // one visible prompt is enough to warrant the rail.
    return count >= MIN_JUMP_TARGETS || (count >= 1 && hasOlder);
  });

  protected markers = computed(() => {
    const g = this.geometry();
    const ticks = this.ticks();
    // Codex-style: ticks form a fixed-spacing cluster centred in the rail, so
    // positions depend only on the tick count — no anchor alignment needed.
    if (g.railHeight <= 0) return [];
    const tops = computeMarkerLayout(ticks.length, g.railHeight);
    return ticks.map((tick, i) => ({ tick, top: tops[i] }));
  });

  protected activeIndex = computed(() => {
    const g = this.geometry();
    if (g.anchorTops.length !== this.ticks().length) return -1;
    return activeMarkerIndex(g.anchorTops, g.scrollTop, g.clientHeight);
  });

  protected hoverPreview = computed(() => {
    const index = this.hoveredIndex();
    const marker = this.markers()[index];
    if (index < 0 || !marker) return null;
    const railHeight = this.geometry().railHeight;
    const cardTop = Math.max(0, Math.min(marker.top - 12, railHeight - PREVIEW_APPROX_HEIGHT));
    const files = marker.tick.target?.files ?? [];
    return {
      tick: marker.tick,
      cardTop,
      chips: files.slice(0, MAX_PREVIEW_FILE_CHIPS),
      moreCount: Math.max(0, files.length - MAX_PREVIEW_FILE_CHIPS),
    };
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
      this.sessionPrompts();
      this.scheduleMeasure();
    });

    // Visibility flipping toggles the transcript's left padding (parent CSS),
    // which reflows content without resizing the viewport box — re-measure.
    effect(() => {
      this.visible();
      this.scheduleMeasure();
    });

    // Viewport listeners: scroll drives the active tick (and cheaply
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

    // Stub-tick jump driver: each time the loaded targets change (an older
    // page arrived), either jump to the now-loaded prompt or request another
    // page while the transcript still has older messages to give.
    effect(() => {
      const pendingId = this.pendingJumpMessageId();
      if (!pendingId) return;
      const target = this.targets().find((t) => t.messageId === pendingId);
      if (target) {
        this.pendingJumpMessageId.set(null);
        this.jumpToTarget(target);
        return;
      }
      if (!this.hasOlderMessages() || this.pendingJumpLoads >= MAX_PENDING_JUMP_LOADS) {
        this.pendingJumpMessageId.set(null);
        return;
      }
      this.pendingJumpLoads++;
      this.loadOlder.emit();
    });

    this.destroyRef.onDestroy(() => this.clearHoverTimer());
  }

  protected jumpTo(index: number): void {
    const tick = this.ticks()[index];
    if (!tick) return;
    if (tick.target) {
      this.pendingJumpMessageId.set(null);
      this.jumpToTarget(tick.target);
      return;
    }
    // Message not in the rendered window — load older pages until it arrives.
    this.pendingJumpLoads = 0;
    this.pendingJumpMessageId.set(tick.messageId);
  }

  private jumpToTarget(target: JumpTarget): void {
    const vp = this.viewport();
    if (!vp) return;
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
   * to the scroll container, its nearest positioned ancestor; NaN for ticks
   * whose messages are not in the rendered window), scroll metrics, and the
   * rail's own height. O(user messages) layout reads, no writes.
   */
  private measure(): void {
    const vp = this.viewport();
    if (!vp) {
      this.geometry.set(EMPTY_GEOMETRY);
      return;
    }
    const anchorTops = this.ticks().map((tick) =>
      tick.target ? this.findRow(vp, tick.target.itemId)?.offsetTop ?? 0 : Number.NaN,
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
