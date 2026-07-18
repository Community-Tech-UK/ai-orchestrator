import { computed, signal } from '@angular/core';

/** Top-level display items rendered during normal streaming. */
export const RENDER_WINDOW_DEFAULT = 250;
/** Items revealed per scroll-edge or explicit expansion. */
export const RENDER_WINDOW_EXPAND_STEP = 250;

/**
 * Keeps a trailing, per-instance view over a loaded transcript collection.
 * The source remains intact; only the items exposed to the DOM are bounded.
 */
export class OutputStreamRenderWindow<T> {
  private readonly countByInstance = signal(new Map<string, number>());

  readonly items = computed<T[]>(() => {
    const items = this.sourceItems();
    const limit = this.countByInstance().get(this.instanceId()) ?? RENDER_WINDOW_DEFAULT;
    return items.length > limit ? items.slice(items.length - limit) : items;
  });

  readonly hiddenCount = computed(() => this.sourceItems().length - this.items().length);

  constructor(
    private readonly instanceId: () => string,
    private readonly sourceItems: () => T[],
  ) {}

  expand(by = RENDER_WINDOW_EXPAND_STEP): boolean {
    if (this.hiddenCount() === 0) return false;
    this.grow(this.instanceId(), by);
    return true;
  }

  grow(instanceId: string, by: number): void {
    if (by <= 0) return;
    this.countByInstance.update((current) => {
      const next = new Map<string, number>(current);
      next.set(instanceId, (current.get(instanceId) ?? RENDER_WINDOW_DEFAULT) + by);
      return next;
    });
  }
}
