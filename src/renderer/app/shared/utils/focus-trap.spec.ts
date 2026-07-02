import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFocusTrap } from './focus-trap';

function dispatchTab(target: HTMLElement, shiftKey = false): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    bubbles: true,
    cancelable: true,
    shiftKey,
  });
  target.dispatchEvent(event);
  return event;
}

describe('createFocusTrap', () => {
  let root: HTMLDivElement;
  let outside: HTMLButtonElement;
  let container: HTMLDivElement;
  let first: HTMLButtonElement;
  let second: HTMLButtonElement;

  beforeEach(() => {
    root = document.createElement('div');
    outside = document.createElement('button');
    outside.textContent = 'outside';
    container = document.createElement('div');
    first = document.createElement('button');
    first.textContent = 'first';
    second = document.createElement('button');
    second.textContent = 'second';

    container.append(first, second);
    root.append(outside, container);
    document.body.append(root);
    outside.focus();
  });

  afterEach(() => {
    root.remove();
  });

  it('focuses the first focusable element when activated', () => {
    const trap = createFocusTrap(container);

    trap.activate();

    expect(document.activeElement).toBe(first);
    trap.deactivate();
    trap.restore();
  });

  it('cycles Tab and Shift+Tab within the active container', () => {
    const trap = createFocusTrap(container);
    trap.activate();

    second.focus();
    const forward = dispatchTab(second);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backward = dispatchTab(first, true);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(second);
    trap.deactivate();
    trap.restore();
  });

  it('restores the previously focused element on close when it is still connected', () => {
    const trap = createFocusTrap(container);
    trap.activate();

    trap.deactivate();
    trap.restore();

    expect(document.activeElement).toBe(outside);
  });

  it('restore also deactivates the trap when callers skip explicit deactivate', () => {
    const trap = createFocusTrap(container);
    trap.activate();

    trap.restore();
    expect(document.activeElement).toBe(outside);

    first.focus();
    const event = dispatchTab(first);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores stale traps whose container was removed without cleanup', () => {
    const staleRoot = document.createElement('div');
    const staleButton = document.createElement('button');
    staleButton.textContent = 'stale';
    staleRoot.append(staleButton);
    document.body.append(staleRoot);

    const staleTrap = createFocusTrap(staleRoot);
    staleTrap.activate();
    staleRoot.remove();
    outside.focus();

    const trap = createFocusTrap(container);
    trap.activate();
    trap.restore();
    expect(document.activeElement).toBe(outside);

    first.focus();
    const event = dispatchTab(first);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not restore focus to a disconnected element', () => {
    const trap = createFocusTrap(container);
    trap.activate();

    outside.remove();
    trap.deactivate();
    trap.restore();

    expect(document.activeElement).not.toBe(outside);
  });

  it('restores nested traps to the parent overlay instead of the page underneath', () => {
    const nested = document.createElement('div');
    const nestedButton = document.createElement('button');
    nestedButton.textContent = 'nested';
    nested.append(nestedButton);
    container.append(nested);

    const parentTrap = createFocusTrap(container);
    parentTrap.activate();
    second.focus();

    const nestedTrap = createFocusTrap(nested);
    nestedTrap.activate();
    expect(document.activeElement).toBe(nestedButton);

    nestedTrap.deactivate();
    nestedTrap.restore();

    expect(document.activeElement).toBe(second);

    parentTrap.deactivate();
    parentTrap.restore();
    expect(document.activeElement).toBe(outside);
  });
});
