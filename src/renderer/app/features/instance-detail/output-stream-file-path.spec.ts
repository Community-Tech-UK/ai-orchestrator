import { describe, expect, it, vi } from 'vitest';
import { OutputStreamComponent } from './output-stream.component';

describe('delegated transcript file path activation', () => {
  function setup() {
    const container = document.createElement('div');
    container.innerHTML = '<code class="file-path" data-file-path="src/app.ts" tabindex="0" role="link">src/app.ts</code><a data-file-path="src/other.ts" href="src/other.ts">other</a>';
    const openPath = vi.fn().mockResolvedValue({ success: true });
    // Invoke the production listener and its path-opening chain without unrelated
    // streaming effects, matching the existing delegated-followup spec seam.
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      getViewportElement: () => container,
      instanceId: () => 'local-session',
      instanceStore: { getInstance: () => ({ workingDirectory: '/tmp/project' }) },
      fileIpc: { openPath },
    }) as { setupDelegatedClickHandler(): { element: HTMLElement; listener: EventListener; cleanup: () => void } };
    const binding = component.setupDelegatedClickHandler();
    return { container, openPath, binding };
  }
  it.each(['Enter', ' '])('opens a focused code path once on %j', (key) => {
    const { container, openPath } = setup();
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    container.querySelector('code')!.dispatchEvent(event);
    expect(openPath).toHaveBeenCalledExactlyOnceWith('/tmp/project/src/app.ts');
    expect(event.defaultPrevented).toBe(true);
  });
  it('keeps click working, ignores other keys and leaves anchors to native keyboard activation', () => {
    const { container, openPath } = setup();
    container.querySelector('code')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    container.querySelector('a')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openPath).not.toHaveBeenCalled();
    container.querySelector('code')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openPath).toHaveBeenCalledExactlyOnceWith('/tmp/project/src/app.ts');
  });
  it('removes keyboard activation with the viewport cleanup', () => {
    const { container, openPath, binding } = setup();
    binding.cleanup();
    container.querySelector('code')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    container.querySelector('code')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openPath).not.toHaveBeenCalled();
  });
});
