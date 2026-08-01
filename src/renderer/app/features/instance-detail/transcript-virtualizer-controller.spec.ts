import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TranscriptVirtualizerController } from './transcript-virtualizer-controller';

interface Item {
  id: string;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}` }));
}

/** Minimal ResizeObserver stand-in — jsdom does not implement the real API. */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  readonly observed: Element[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(el: Element): void {
    const index = this.observed.indexOf(el);
    if (index >= 0) this.observed.splice(index, 1);
  }
  disconnect(): void {
    this.observed.length = 0;
  }
  trigger(entries: { target: Element; height: number }[]): void {
    this.callback(
      entries.map((e) => ({
        target: e.target,
        contentRect: { height: e.height } as DOMRectReadOnly,
        borderBoxSize: [] as unknown as readonly ResizeObserverSize[],
      })) as ResizeObserverEntry[],
      this as unknown as ResizeObserver,
    );
  }
}

function makeViewport(rowIds: string[]): HTMLDivElement {
  const vp = document.createElement('div');
  for (const id of rowIds) {
    const row = document.createElement('div');
    row.className = 'transcript-item';
    row.setAttribute('data-item-id', id);
    vp.appendChild(row);
  }
  return vp;
}

function harness(
  overrides: Partial<{
    items: Item[];
    enabled: boolean;
    bypass: boolean;
    isScrolledUp: boolean;
    pinned: Set<string>;
  }> = {},
) {
  const items = overrides.items ?? makeItems(5);
  const state = {
    enabled: overrides.enabled ?? true,
    bypass: overrides.bypass ?? false,
    isScrolledUp: overrides.isScrolledUp ?? true,
  };
  const pinned = overrides.pinned ?? new Set<string>();
  let viewport: HTMLDivElement | null = makeViewport(items.map((i) => i.id));

  const controller = new TranscriptVirtualizerController<Item>({
    getViewportElement: () => viewport,
    getInstanceId: () => 'instance-a',
    getItems: () => items,
    enabled: () => state.enabled,
    bypass: () => state.bypass,
    isPinned: (item) => pinned.has(item.id),
    isScrolledUp: () => state.isScrolledUp,
  });

  return {
    controller,
    items,
    state,
    get viewport() {
      return viewport;
    },
    setViewport(el: HTMLDivElement | null) {
      viewport = el;
    },
  };
}

describe('TranscriptVirtualizerController', () => {
  beforeEach(() => {
    MockResizeObserver.instances = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes every item through as a row when disabled (flag-off parity)', () => {
    const { controller, items } = harness({ enabled: false });
    expect(controller.segments()).toEqual(items.map((item) => ({ type: 'row', id: item.id, item })));
  });

  it('passes every item through as a row when bypassed, even if enabled', () => {
    const { controller, items } = harness({ enabled: true, bypass: true });
    expect(controller.segments()).toEqual(items.map((item) => ({ type: 'row', id: item.id, item })));
  });

  it('recordViewportState() reads scrollTop/clientHeight from the live viewport into the window computation', () => {
    const { controller, viewport } = harness({ items: makeItems(20), isScrolledUp: true });
    Object.defineProperty(viewport!, 'scrollTop', { value: 1050, configurable: true });
    Object.defineProperty(viewport!, 'clientHeight', { value: 100, configurable: true });

    controller.recordViewportState();

    const rows = controller.segments().filter((s) => s.type === 'row');
    // Default estimated row height is 96px; scrollTop 1050 with a 100px
    // viewport should land on rows around index 11 (1050/96 ≈ 10.9).
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(20);
  });

  it('sticks to the tail when isScrolledUp() is false, independent of the recorded scrollTop', () => {
    const { controller, viewport } = harness({ items: makeItems(20), isScrolledUp: false });
    Object.defineProperty(viewport!, 'scrollTop', { value: 0, configurable: true });
    Object.defineProperty(viewport!, 'clientHeight', { value: 96, configurable: true });
    controller.recordViewportState();

    const rows = controller.segments().filter((s) => s.type === 'row') as { id: string }[];
    expect(rows.at(-1)?.id).toBe('item-19');
  });

  it('keeps pinned rows rendered even when scrolled far away from them', () => {
    const { controller, viewport } = harness({
      items: makeItems(20),
      isScrolledUp: true,
      pinned: new Set(['item-1']),
    });
    Object.defineProperty(viewport!, 'scrollTop', { value: 1800, configurable: true });
    Object.defineProperty(viewport!, 'clientHeight', { value: 100, configurable: true });
    controller.recordViewportState();

    const rowIds = controller.segments().filter((s) => s.type === 'row').map((s) => (s as { id: string }).id);
    expect(rowIds).toContain('item-1');
  });

  it('attach() wires a scroll listener that updates the window, and the returned cleanup detaches it', () => {
    const { controller, viewport } = harness({ items: makeItems(20), isScrolledUp: true });
    Object.defineProperty(viewport!, 'clientHeight', { value: 100, configurable: true });

    const detach = controller.attach();

    Object.defineProperty(viewport!, 'scrollTop', { value: 1050, configurable: true });
    viewport!.dispatchEvent(new Event('scroll'));
    const rowsAfterFirstScroll = controller.segments().filter((s) => s.type === 'row').length;
    expect(rowsAfterFirstScroll).toBeLessThan(20);

    detach();

    // After detaching, further scroll events must not move the window.
    Object.defineProperty(viewport!, 'scrollTop', { value: 0, configurable: true });
    viewport!.dispatchEvent(new Event('scroll'));
    const rowsAfterDetach = controller.segments().filter((s) => s.type === 'row').length;
    expect(rowsAfterDetach).toBe(rowsAfterFirstScroll);
  });

  it('reconcileObservedRows() observes newly rendered rows and measurement bumps the height cache + recomputes segments', () => {
    const { controller, viewport } = harness({ items: makeItems(3) });
    controller.reconcileObservedRows();

    const rowObserver = MockResizeObserver.instances.at(-1);
    expect(rowObserver).toBeDefined();
    const row0 = viewport!.querySelector('[data-item-id="item-0"]') as HTMLElement;
    expect(rowObserver!.observed).toContain(row0);

    rowObserver!.trigger([{ target: row0, height: 260 }]);

    expect(controller.heightCache.get('instance-a', 'item-0')).toBe(260);
  });

  it('reconcileObservedRows() unobserves rows that are no longer rendered', () => {
    const { controller, viewport } = harness({ items: makeItems(3) });
    controller.reconcileObservedRows();
    const rowObserver = MockResizeObserver.instances.at(-1)!;
    const row0 = viewport!.querySelector('[data-item-id="item-0"]') as HTMLElement;
    expect(rowObserver.observed).toContain(row0);

    row0.remove();
    controller.reconcileObservedRows();
    expect(rowObserver.observed).not.toContain(row0);
  });

  it('scrollToId() resolves the target offset and applies it to both the signal and the live viewport', () => {
    const { controller, viewport } = harness({ items: makeItems(10) });
    const target = controller.scrollToId('item-4');
    // 4 unmeasured rows * default estimate (96px) = 384.
    expect(target).toBe(4 * 96);
    expect(viewport!.scrollTop).toBe(target);
  });

  it('scrollToId() returns null for an id outside the loaded items', () => {
    const { controller } = harness({ items: makeItems(3) });
    expect(controller.scrollToId('not-loaded')).toBeNull();
  });

  it('scrollToId() returns null when there is no viewport', () => {
    const { controller, setViewport } = harness({ items: makeItems(3) });
    setViewport(null);
    expect(controller.scrollToId('item-0')).toBeNull();
  });

  it('saveAnchorForInstance()/restoreScrollTopForInstance() round-trip the topmost fully-visible row', () => {
    const { controller, viewport } = harness({ items: makeItems(10) });
    Object.defineProperty(viewport!, 'scrollTop', { value: 50, configurable: true });
    Object.defineProperty(viewport!, 'clientHeight', { value: 200, configurable: true });
    const row3 = viewport!.querySelector('[data-item-id="item-3"]') as HTMLElement;
    Object.defineProperty(row3, 'offsetTop', { value: 350, configurable: true }); // 350 - 50 = 300 from viewport top
    Object.defineProperty(row3, 'offsetHeight', { value: 96, configurable: true });

    controller.saveAnchorForInstance('instance-a');
    const restored = controller.restoreScrollTopForInstance('instance-a');

    // item-3's cumulative offset with default estimated heights is 3*96=288;
    // the saved anchor offset was 300, so target clamps to 0.
    expect(restored).toBe(0);
  });

  it('restoreScrollTopForInstance() returns null for a session with no saved anchor', () => {
    const { controller } = harness();
    expect(controller.restoreScrollTopForInstance('never-visited')).toBeNull();
  });

  it('recordScrollTopValue() sets the window position without reading the live viewport', () => {
    const { controller } = harness({ items: makeItems(20), isScrolledUp: true });
    controller.recordScrollTopValue(1050);
    const rows = controller.segments().filter((s) => s.type === 'row');
    expect(rows.length).toBeLessThan(20);
  });

  it('attach() and reconcileObservedRows() are no-ops when there is no viewport', () => {
    const { controller, setViewport } = harness();
    setViewport(null);
    expect(() => controller.attach()()).not.toThrow();
    expect(() => controller.reconcileObservedRows()).not.toThrow();
  });
});
