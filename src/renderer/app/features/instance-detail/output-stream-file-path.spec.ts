import { describe, expect, it, vi } from 'vitest';
import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import { OutputStreamComponent } from './output-stream.component';
import type { LinkedFileTarget } from './output-stream.types';

describe('transcript file path "Copy path"', () => {
  function setup(fileStats: unknown) {
    const copyText = vi.fn().mockResolvedValue({ ok: true });
    const getFileStats = vi.fn().mockResolvedValue(fileStats);
    // Same prototype seam as the activation specs below: the production menu
    // builder and copy chain, without the component's streaming effects.
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      instanceId: () => 'local-session',
      instanceStore: { getInstance: () => ({ workingDirectory: '/tmp/project' }) },
      fileIpc: { getFileStats },
      clipboard: { copyText },
    }) as {
      buildLinkedFileTarget(rawPath: string): LinkedFileTarget;
      buildFileContextMenuItems(target: LinkedFileTarget): ContextMenuItem[];
    };
    const [copyPath] = component.buildFileContextMenuItems(component.buildLinkedFileTarget('src/app.ts'));
    return { copyPath, copyText, getFileStats };
  }

  it('copies the full location when the file is there', async () => {
    const { copyPath, copyText, getFileStats } = setup({ name: 'app.ts', path: '/tmp/project/src/app.ts' });
    expect(copyPath.label).toBe('Copy path');
    void copyPath.action();
    await vi.waitFor(() => expect(copyText).toHaveBeenCalled());
    expect(getFileStats).toHaveBeenCalledExactlyOnceWith('/tmp/project/src/app.ts');
    expect(copyText).toHaveBeenCalledExactlyOnceWith('/tmp/project/src/app.ts', { label: 'path' });
  });

  it('copies the path as written when the file is not in the session folder', async () => {
    const { copyPath, copyText } = setup(null);
    void copyPath.action();
    await vi.waitFor(() => expect(copyText).toHaveBeenCalled());
    expect(copyText).toHaveBeenCalledExactlyOnceWith('src/app.ts', { label: 'path' });
  });
});

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
