/**
 * Unit Tests for DropZoneComponent
 *
 * Covers:
 * - Component creation
 * - Drag counter semantics (nested enter/leave don't prematurely dismiss overlay)
 * - Drop emits appropriate outputs (files, folders, explorer paths, multi-select)
 * - Paste emits image files
 * - Escape while overlay is visible dismisses it (and stops propagation)
 * - Escape while overlay is hidden is a no-op (doesn't swallow the key)
 * - Global safety-net listeners (window:blur, window:dragend, window:drop)
 *   reset state when local drag events don't fire
 * - Listeners are cleaned up on destroy
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DropZoneComponent } from './drop-zone.component';

/**
 * Build a minimal DragEvent-shaped object. jsdom doesn't implement DragEvent or
 * DataTransfer, so we hand-roll one with the fields the component touches.
 */
interface FakeDataTransferItem {
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

interface FakeDataTransfer {
  items?: FakeDataTransferItem[];
  files?: File[];
  getData?: (format: string) => string;
}

function makeDragEvent(overrides: Partial<{
  dataTransfer: FakeDataTransfer;
}> = {}): DragEvent {
  const base = {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: overrides.dataTransfer ?? {
      items: [],
      files: [],
      getData: () => '',
    },
  };
  return base as unknown as DragEvent;
}

function makeFile(name: string, type = 'text/plain', pathOverride?: string): File {
  const file = new File([new Blob(['contents'], { type })], name, { type });
  if (pathOverride !== undefined) {
    Object.defineProperty(file, 'path', { value: pathOverride, configurable: true });
  }
  return file;
}

describe('DropZoneComponent', () => {
  let component: DropZoneComponent;
  let fixture: ComponentFixture<DropZoneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DropZoneComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DropZoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  // ============================================
  // Component Creation
  // ============================================

  describe('Component Creation', () => {
    it('creates the component', () => {
      expect(component).toBeTruthy();
    });

    it('starts with the overlay hidden', () => {
      expect(component.isDragOver()).toBe(false);
    });
  });

  // ============================================
  // Drag Counter Semantics
  // ============================================

  describe('Drag Counter', () => {
    it('shows overlay on dragenter', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);
    });

    it('shows overlay on dragover even if dragenter was missed', () => {
      // Simulates a drag that started inside a child that swallowed dragenter.
      expect(component.isDragOver()).toBe(false);
      component.onDragOver(makeDragEvent());
      expect(component.isDragOver()).toBe(true);
    });

    it('keeps overlay visible while nested dragenter/dragleave pairs are unbalanced', () => {
      // Entering the root, then a child — counter should be 2.
      component.onDragEnter(makeDragEvent());
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      // Leaving the child only. Counter drops to 1, still visible.
      component.onDragLeave(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      // Leaving the root. Counter drops to 0, now hidden.
      component.onDragLeave(makeDragEvent());
      expect(component.isDragOver()).toBe(false);
    });

    it('does not go negative if dragleave fires more times than dragenter', () => {
      component.onDragLeave(makeDragEvent());
      component.onDragLeave(makeDragEvent());
      component.onDragEnter(makeDragEvent());
      // After one enter, overlay should be visible (counter = 1, not -1).
      expect(component.isDragOver()).toBe(true);
    });

    it('calls preventDefault on dragover (required for drop to fire)', () => {
      const event = makeDragEvent();
      component.onDragOver(event);
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  // ============================================
  // Drop Handling
  // ============================================

  describe('Drop Handling', () => {
    it('hides overlay on drop', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      component.onDrop(makeDragEvent());
      expect(component.isDragOver()).toBe(false);
    });

    it('resets counter on drop even if extra dragenters were unmatched', () => {
      component.onDragEnter(makeDragEvent());
      component.onDragEnter(makeDragEvent());
      component.onDragEnter(makeDragEvent());

      component.onDrop(makeDragEvent());
      expect(component.isDragOver()).toBe(false);

      // A subsequent single dragleave must NOT reopen/underflow state.
      component.onDragLeave(makeDragEvent());
      expect(component.isDragOver()).toBe(false);
    });

    it('emits filesDropped with dropped files', () => {
      const emit = vi.spyOn(component.filesDropped, 'emit');
      const file = makeFile('hello.txt');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
          files: [file],
        },
      }));

      expect(emit).toHaveBeenCalledWith([file]);
    });

    it('emits folderDropped when a directory is dropped', () => {
      const folderEmit = vi.spyOn(component.folderDropped, 'emit');
      const filesEmit = vi.spyOn(component.filesDropped, 'emit');
      const folderFile = makeFile('my-folder', '', '/abs/path/to/my-folder');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
          files: [folderFile],
        },
      }));

      expect(folderEmit).toHaveBeenCalledWith('/abs/path/to/my-folder');
      expect(filesEmit).not.toHaveBeenCalled();
    });

    it('emits both folderDropped and filesDropped when mixed', () => {
      const folderEmit = vi.spyOn(component.folderDropped, 'emit');
      const filesEmit = vi.spyOn(component.filesDropped, 'emit');
      const folderFile = makeFile('some-dir', '', '/abs/some-dir');
      const regularFile = makeFile('note.md', 'text/markdown');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [
            { webkitGetAsEntry: () => ({ isDirectory: true }) },
            { webkitGetAsEntry: () => ({ isDirectory: false }) },
          ],
          files: [folderFile, regularFile],
        },
      }));

      expect(folderEmit).toHaveBeenCalledWith('/abs/some-dir');
      expect(filesEmit).toHaveBeenCalledWith([regularFile]);
    });

    it('emits folderDropped from explorer application/x-folder-path data', () => {
      const emit = vi.spyOn(component.folderDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'application/x-folder-path' ? '/explorer/path' : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith('/explorer/path');
    });

    it('emits filePathsDropped from multi-select explorer drag', () => {
      const emit = vi.spyOn(component.filePathsDropped, 'emit');
      const paths = ['/a.ts', '/b.ts'];

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'application/x-file-paths' ? JSON.stringify(paths) : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith(paths);
    });

    it('emits filePathDropped from single-file explorer drag', () => {
      const emit = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'application/x-file-path' ? '/single.ts' : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith('/single.ts');
    });

    it('ignores malformed filePaths JSON and falls through', () => {
      const multiEmit = vi.spyOn(component.filePathsDropped, 'emit');
      const singleEmit = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) => {
            if (format === 'application/x-file-paths') return 'not-json';
            if (format === 'application/x-file-path') return '/fallback.ts';
            return '';
          },
        },
      }));

      expect(multiEmit).not.toHaveBeenCalled();
      expect(singleEmit).toHaveBeenCalledWith('/fallback.ts');
    });

    // ============================================
    // External drag sources (VSCode, Finder, browsers)
    // ============================================

    it('emits filePathDropped from VSCode codefiles (single)', () => {
      const emit = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'codefiles' ? '["/Users/x/foo.md"]' : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith('/Users/x/foo.md');
    });

    it('emits filePathsDropped from VSCode codefiles (multiple)', () => {
      const emit = vi.spyOn(component.filePathsDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'codefiles' ? '["/a.ts","/b.ts"]' : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith(['/a.ts', '/b.ts']);
    });

    it('decodes VSCode resourceurls into local paths', () => {
      const emit = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'resourceurls'
              ? '["file:///Users/x/has%20space.md"]'
              : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith('/Users/x/has space.md');
    });

    it('decodes text/uri-list (Finder/Chrome cross-app format)', () => {
      const emit = vi.spyOn(component.filePathsDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'text/uri-list'
              ? '# comment line\r\nfile:///a.ts\r\nfile:///b.ts\r\n'
              : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith(['/a.ts', '/b.ts']);
    });

    it('skips non-file URIs in text/uri-list', () => {
      const single = vi.spyOn(component.filePathDropped, 'emit');
      const multi = vi.spyOn(component.filePathsDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'text/uri-list'
              ? 'https://example.com\nfile:///only.ts'
              : '',
        },
      }));

      expect(single).toHaveBeenCalledWith('/only.ts');
      expect(multi).not.toHaveBeenCalled();
    });

    it('falls back to text/plain when it looks like an absolute path', () => {
      const emit = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'text/plain' ? '/Users/x/notes.md' : '',
        },
      }));

      expect(emit).toHaveBeenCalledWith('/Users/x/notes.md');
    });

    it('ignores text/plain that is not a path-shaped string', () => {
      const single = vi.spyOn(component.filePathDropped, 'emit');
      const multi = vi.spyOn(component.filePathsDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) =>
            format === 'text/plain'
              ? 'some pasted sentence\nwith a newline'
              : '',
        },
      }));

      expect(single).not.toHaveBeenCalled();
      expect(multi).not.toHaveBeenCalled();
    });

    it('prefers internal explorer formats over external ones', () => {
      const internal = vi.spyOn(component.filePathDropped, 'emit');

      component.onDrop(makeDragEvent({
        dataTransfer: {
          items: [],
          files: [],
          getData: (format) => {
            if (format === 'application/x-file-path') return '/from-explorer.ts';
            if (format === 'codefiles') return '["/from-vscode.ts"]';
            return '';
          },
        },
      }));

      expect(internal).toHaveBeenCalledTimes(1);
      expect(internal).toHaveBeenCalledWith('/from-explorer.ts');
    });
  });

  // ============================================
  // Paste Handling
  // ============================================

  describe('Paste Handling', () => {
    it('emits imagesPasted when an image is in the clipboard', () => {
      const emit = vi.spyOn(component.imagesPasted, 'emit');
      const imageFile = makeFile('clipboard.png', 'image/png');

      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          items: [
            {
              type: 'image/png',
              getAsFile: () => imageFile,
            },
          ],
        },
      } as unknown as ClipboardEvent;

      component.onPaste(event);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(emit).toHaveBeenCalledTimes(1);
      const pasted = emit.mock.calls[0][0];
      expect(pasted).toHaveLength(1);
      expect(pasted[0].type).toBe('image/png');
      // File is renamed to pasted-image-N.png
      expect(pasted[0].name).toMatch(/^pasted-image-\d+\.png$/);
    });

    it('ignores non-image clipboard items', () => {
      const emit = vi.spyOn(component.imagesPasted, 'emit');

      const event = {
        preventDefault: vi.fn(),
        clipboardData: {
          items: [
            { type: 'text/plain', getAsFile: () => null },
          ],
        },
      } as unknown as ClipboardEvent;

      component.onPaste(event);

      expect(emit).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('handles clipboard with no items gracefully', () => {
      const emit = vi.spyOn(component.imagesPasted, 'emit');

      const event = {
        preventDefault: vi.fn(),
        clipboardData: null,
      } as unknown as ClipboardEvent;

      component.onPaste(event);

      expect(emit).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Escape Key Dismisses Overlay
  // ============================================

  describe('Escape Key', () => {
    it('dismisses the overlay when it is visible', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(component.isDragOver()).toBe(false);
    });

    it('stops propagation so parent Escape handlers do not fire', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      // Install a bubble-phase listener that would normally fire after our
      // capture-phase listener. It should NOT run because our listener calls
      // stopImmediatePropagation.
      const bubbleSpy = vi.fn();
      window.addEventListener('keydown', bubbleSpy);
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(bubbleSpy).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', bubbleSpy);
      }
    });

    it('does NOT swallow Escape when the overlay is hidden', () => {
      expect(component.isDragOver()).toBe(false);

      const bubbleSpy = vi.fn();
      window.addEventListener('keydown', bubbleSpy);
      try {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        // Bubble-phase listener MUST still fire — the Escape-to-interrupt
        // behavior in parent components must not be broken by this component.
        expect(bubbleSpy).toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', bubbleSpy);
      }
    });

    it('ignores other keys when the overlay is visible', () => {
      component.onDragEnter(makeDragEvent());

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      expect(component.isDragOver()).toBe(true);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      expect(component.isDragOver()).toBe(true);
    });
  });

  // ============================================
  // Global Safety-Net Listeners
  // ============================================

  describe('Global Safety-Net Listeners', () => {
    it('resets on window blur', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      window.dispatchEvent(new Event('blur'));
      expect(component.isDragOver()).toBe(false);
    });

    it('resets on window dragend', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      window.dispatchEvent(new Event('dragend'));
      expect(component.isDragOver()).toBe(false);
    });

    it('resets on window drop', () => {
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);

      window.dispatchEvent(new Event('drop'));
      expect(component.isDragOver()).toBe(false);
    });

    it('resetting on blur clears the counter so subsequent drags work normally', () => {
      // Build up counter, then blur resets it.
      component.onDragEnter(makeDragEvent());
      component.onDragEnter(makeDragEvent());
      window.dispatchEvent(new Event('blur'));
      expect(component.isDragOver()).toBe(false);

      // Now a fresh drag should show overlay after a single dragenter, and
      // a single dragleave should hide it (counter must not be negative).
      component.onDragEnter(makeDragEvent());
      expect(component.isDragOver()).toBe(true);
      component.onDragLeave(makeDragEvent());
      expect(component.isDragOver()).toBe(false);
    });
  });

  // ============================================
  // Cleanup on Destroy
  // ============================================

  describe('Cleanup', () => {
    it('removes window listeners on destroy', () => {
      // Sanity check: listener is active before destroy.
      component.onDragEnter(makeDragEvent());
      window.dispatchEvent(new Event('blur'));
      expect(component.isDragOver()).toBe(false);

      fixture.destroy();

      // After destroy, the reset handler should no longer be attached.
      // Re-setting the signal directly and dispatching blur should not reset it.
      component.isDragOver.set(true);
      window.dispatchEvent(new Event('blur'));
      expect(component.isDragOver()).toBe(true);
    });

    it('does not swallow Escape after destroy', () => {
      fixture.destroy();

      const bubbleSpy = vi.fn();
      window.addEventListener('keydown', bubbleSpy);
      try {
        // Even if the destroyed component's signal is somehow true, the
        // listener should be gone and Escape should propagate normally.
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(bubbleSpy).toHaveBeenCalled();
      } finally {
        window.removeEventListener('keydown', bubbleSpy);
      }
    });
  });
});
