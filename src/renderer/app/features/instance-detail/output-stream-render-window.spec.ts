import { describe, it, expect } from 'vitest';
import { signal } from '@angular/core';
import {
  OutputStreamRenderWindow,
  RENDER_WINDOW_DEFAULT,
  RENDER_WINDOW_EXPAND_STEP,
} from './output-stream-render-window';

/**
 * Unit tests for OutputStreamComponent's bounded-DOM render window.
 *
 * Only the trailing render window is exposed to the component; earlier loaded
 * items re-enter through expansion without another persistence fetch.
 */

interface Item {
  id: string;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}` }));
}

function makeWindowHarness(instanceId: () => string, visibleItems: () => Item[]) {
  const renderWindow = new OutputStreamRenderWindow(instanceId, visibleItems);
  return {
    windowedItems: renderWindow.items,
    hiddenRenderedCount: renderWindow.hiddenCount,
    growRenderWindow: (id: string, by: number) => renderWindow.grow(id, by),
    expandRenderWindow: () => renderWindow.expand(RENDER_WINDOW_EXPAND_STEP),
  };
}

describe('OutputStreamComponent render window', () => {
  it('renders everything when the loaded list fits the window', () => {
    const items = makeItems(40);
    const harness = makeWindowHarness(() => 'a', () => items);

    expect(harness.windowedItems()).toBe(items);
    expect(harness.hiddenRenderedCount()).toBe(0);
  });

  it('renders only the trailing window for long transcripts', () => {
    const items = makeItems(700);
    const harness = makeWindowHarness(() => 'a', () => items);

    const rendered = harness.windowedItems();
    expect(rendered).toHaveLength(RENDER_WINDOW_DEFAULT);
    expect(rendered[0].id).toBe('item-450');
    expect(rendered[rendered.length - 1].id).toBe('item-699');
    expect(harness.hiddenRenderedCount()).toBe(450);
  });

  it('keeps the tail rendered as streaming appends items (window slides)', () => {
    const items = signal(makeItems(300));
    const harness = makeWindowHarness(() => 'a', () => items());

    items.update((current) => [...current, { id: 'item-300' }]);

    const rendered = harness.windowedItems();
    expect(rendered[rendered.length - 1].id).toBe('item-300');
    expect(rendered).toHaveLength(RENDER_WINDOW_DEFAULT);
  });

  it('expands stepwise and reveals all items after enough expansions', () => {
    const items = makeItems(600);
    const harness = makeWindowHarness(() => 'a', () => items);

    harness.expandRenderWindow();
    expect(harness.windowedItems()).toHaveLength(500);
    expect(harness.hiddenRenderedCount()).toBe(100);

    harness.expandRenderWindow();
    expect(harness.windowedItems()).toHaveLength(600);
    expect(harness.hiddenRenderedCount()).toBe(0);

    // Fully revealed: further expansion is a no-op.
    harness.expandRenderWindow();
    expect(harness.windowedItems()).toHaveLength(600);
  });

  it('keeps window sizes per instance so switching restores identical content', () => {
    const currentInstance = signal('a');
    const items = makeItems(600);
    const harness = makeWindowHarness(() => currentInstance(), () => items);

    harness.expandRenderWindow();
    expect(harness.windowedItems()).toHaveLength(500);

    currentInstance.set('b');
    expect(harness.windowedItems()).toHaveLength(RENDER_WINDOW_DEFAULT);

    currentInstance.set('a');
    expect(harness.windowedItems()).toHaveLength(500);
  });

  it('grows by the prepended count so loaded older pages enter the DOM', () => {
    const items = signal(makeItems(250));
    const harness = makeWindowHarness(() => 'a', () => items());

    // Simulate loadOlderMessages prepending a 200-message page.
    const olderPage = Array.from({ length: 200 }, (_, i) => ({ id: `older-${i}` }));
    items.update((current) => [...olderPage, ...current]);
    harness.growRenderWindow('a', 200);

    expect(harness.windowedItems()).toHaveLength(450);
    expect(harness.hiddenRenderedCount()).toBe(0);
    expect(harness.windowedItems()[0].id).toBe('older-0');
  });
});
