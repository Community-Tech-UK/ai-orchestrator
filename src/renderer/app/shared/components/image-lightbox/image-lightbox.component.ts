/**
 * Image Lightbox Component
 *
 * A reusable full-screen modal for viewing attachments. Open it imperatively
 * via `open(index)`; it manages its own current index so the parent only needs
 * to supply the list of items.
 *
 * Supports:
 *  - Previous / next navigation (buttons + ArrowLeft / ArrowRight) when there
 *    is more than one item.
 *  - Close via the × button, clicking the backdrop, or Escape.
 *  - Image rendering for image items, with graceful, clearly-worded fallbacks
 *    for non-previewable types AND for images that fail to load.
 *  - Focus management: focus moves into the dialog on open and is restored to
 *    the previously-focused element on close.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  input,
  signal,
  viewChild,
} from '@angular/core';

export interface LightboxItem {
  /** Display name shown in the header. */
  name: string;
  /** Object URL or data URL used as the image source. */
  src: string;
  /** Whether the item should render as an image. */
  isImage: boolean;
  /** Human-readable size string shown in the non-image fallback. */
  size?: string;
}

@Component({
  selector: 'app-image-lightbox',
  standalone: true,
  template: `
    @if (current(); as item) {
      <div
        class="lightbox-overlay"
        (click)="close()"
        (keydown.escape)="close()"
        tabindex="-1"
        role="dialog"
        aria-label="Attachment preview"
        aria-modal="true"
      >
        <div
          #dialog
          class="lightbox-content"
          (click)="$event.stopPropagation()"
          (keydown)="$event.stopPropagation()"
          tabindex="-1"
        >
          <div class="lightbox-header">
            <span class="lightbox-title" [title]="item.name">{{ item.name }}</span>
            <button class="lightbox-close" (click)="close()" title="Close preview" aria-label="Close preview">×</button>
          </div>

          <div class="lightbox-body">
            @if (hasMultiple()) {
              <button
                class="lightbox-nav prev"
                (click)="prev(); $event.stopPropagation()"
                title="Previous"
                aria-label="Previous attachment"
              >
                ‹
              </button>
            }

            @if (canShowImage(item)) {
              <img
                class="lightbox-image"
                [src]="item.src"
                [alt]="item.name"
                (error)="onImageError(item.src)"
              />
            } @else {
              <div class="lightbox-unsupported">
                <p class="lightbox-message">{{ fallbackMessage(item) }}</p>
                <p class="lightbox-detail">{{ item.name }}</p>
                @if (item.size) {
                  <p class="lightbox-size">{{ item.size }}</p>
                }
              </div>
            }

            @if (hasMultiple()) {
              <button
                class="lightbox-nav next"
                (click)="next(); $event.stopPropagation()"
                title="Next"
                aria-label="Next attachment"
              >
                ›
              </button>
            }
          </div>

          @if (hasMultiple()) {
            <div class="lightbox-counter">{{ (currentIndex() ?? 0) + 1 }} / {{ items().length }}</div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .lightbox-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.92);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      padding: 24px;
      isolation: isolate;
      animation: lightbox-fade-in 0.15s ease-out;
    }

    .lightbox-content {
      background: var(--bg-primary);
      border-radius: 12px;
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      animation: lightbox-scale-in 0.18s ease-out;
    }

    .lightbox-content:focus,
    .lightbox-overlay:focus {
      outline: none;
    }

    .lightbox-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      gap: 16px;
    }

    .lightbox-title {
      font-weight: 500;
      font-size: 14px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .lightbox-close {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      font-size: 20px;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      cursor: pointer;
      flex-shrink: 0;
      transition: all 0.15s ease;
    }

    .lightbox-close:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .lightbox-body {
      position: relative;
      flex: 1;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
      min-height: 120px;
    }

    .lightbox-image {
      max-width: 100%;
      max-height: 78vh;
      object-fit: contain;
      border-radius: 8px;
    }

    .lightbox-nav {
      position: absolute;
      top: 50%;
      transform: translateY(-50%);
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      color: var(--text-primary);
      font-size: 26px;
      line-height: 1;
      cursor: pointer;
      transition: all 0.15s ease;
      z-index: 1;
      opacity: 0.85;
    }

    .lightbox-nav:hover {
      background: var(--bg-hover);
      border-color: var(--primary-color);
      opacity: 1;
    }

    .lightbox-nav.prev {
      left: 12px;
    }

    .lightbox-nav.next {
      right: 12px;
    }

    .lightbox-unsupported {
      text-align: center;
      color: var(--text-secondary);
      padding: 48px 24px;
      max-width: 360px;
    }

    .lightbox-message {
      font-size: 14px;
      color: var(--text-primary);
      margin: 0 0 8px;
    }

    .lightbox-detail {
      font-size: 12px;
      color: var(--text-secondary);
      margin: 0;
      word-break: break-word;
    }

    .lightbox-size {
      font-size: 12px;
      opacity: 0.7;
      margin-top: 8px;
    }

    .lightbox-counter {
      text-align: center;
      padding: 8px 16px;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-secondary);
      border-top: 1px solid var(--border-color);
    }

    @keyframes lightbox-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes lightbox-scale-in {
      from { opacity: 0; transform: scale(0.97); }
      to { opacity: 1; transform: scale(1); }
    }

    @media (prefers-reduced-motion: reduce) {
      .lightbox-overlay,
      .lightbox-content {
        animation: none;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageLightboxComponent {
  readonly items = input<LightboxItem[]>([]);
  readonly currentIndex = signal<number | null>(null);

  /** Sources that failed to load as an image — keyed by src so it survives navigation. */
  private readonly failedSrcs = signal<ReadonlySet<string>>(new Set<string>());
  private readonly dialogRef = viewChild<ElementRef<HTMLElement>>('dialog');
  private previouslyFocused: HTMLElement | null = null;
  private pendingFocus = false;

  readonly hasMultiple = computed(() => this.items().length > 1);
  readonly current = computed<LightboxItem | null>(() => {
    const index = this.currentIndex();
    const list = this.items();
    if (index === null || index < 0 || index >= list.length) {
      return null;
    }
    return list[index];
  });

  constructor() {
    // Move focus into the dialog once it has rendered after opening.
    effect(() => {
      const item = this.current();
      const el = this.dialogRef()?.nativeElement;
      if (item && el && this.pendingFocus) {
        this.pendingFocus = false;
        el.focus();
      }
    });
  }

  open(index: number): void {
    const list = this.items();
    if (list.length === 0) {
      return;
    }
    const clamped = Math.min(Math.max(index, 0), list.length - 1);
    this.previouslyFocused =
      typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null;
    this.pendingFocus = true;
    this.currentIndex.set(clamped);
  }

  close(): void {
    this.currentIndex.set(null);
    this.pendingFocus = false;
    const toRestore = this.previouslyFocused;
    this.previouslyFocused = null;
    toRestore?.focus?.();
  }

  next(): void {
    const length = this.items().length;
    const index = this.currentIndex();
    if (index === null || length === 0) {
      return;
    }
    this.currentIndex.set((index + 1) % length);
  }

  prev(): void {
    const length = this.items().length;
    const index = this.currentIndex();
    if (index === null || length === 0) {
      return;
    }
    this.currentIndex.set((index - 1 + length) % length);
  }

  /** True when the item is an image we can actually render (has a src and hasn't failed). */
  canShowImage(item: LightboxItem): boolean {
    return item.isImage && !!item.src && !this.failedSrcs().has(item.src);
  }

  fallbackMessage(item: LightboxItem): string {
    if (item.isImage) {
      return item.src && this.failedSrcs().has(item.src)
        ? 'This image could not be displayed'
        : 'No preview available for this image';
    }
    return 'Preview not available for this file type';
  }

  onImageError(src: string): void {
    if (!src) {
      return;
    }
    const next = new Set(this.failedSrcs());
    next.add(src);
    this.failedSrcs.set(next);
  }

  @HostListener('document:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (this.currentIndex() === null) {
      return;
    }
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        break;
      case 'ArrowRight':
        event.preventDefault();
        this.next();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        this.prev();
        break;
      default:
        break;
    }
  }
}
