/**
 * Drop Zone Component - File drag & drop and image paste handler
 */

import {
  Component,
  output,
  signal,
  HostListener,
  ChangeDetectionStrategy,
  DestroyRef,
  inject,
} from '@angular/core';

@Component({
  selector: 'app-drop-zone',
  standalone: true,
  template: `
    <div
      class="drop-zone"
      [class.drag-over]="isDragOver()"
      (paste)="onPaste($event)"
    >
      @if (isDragOver()) {
        <div class="drop-overlay">
          <div class="drop-content">
            <span class="drop-icon">📎</span>
            <span class="drop-text">Drop files here</span>
          </div>
        </div>
      }

      <ng-content />
    </div>
  `,
  styles: [`
    :host {
      display: contents;
    }

    .drop-zone {
      position: relative;
      display: flex;
      flex: 1;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }

    .drop-overlay {
      position: absolute;
      inset: 0;
      background: rgba(var(--primary-rgb), 0.1);
      border: 2px dashed var(--primary-color);
      border-radius: var(--radius-md);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10;
      backdrop-filter: blur(2px);
    }

    .drop-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .drop-icon {
      font-size: 32px;
    }

    .drop-text {
      font-size: 16px;
      font-weight: 500;
      color: var(--primary-color);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DropZoneComponent {
  // Counter for generating short pasted image names (static to persist across instances)
  private static pastedImageCounter = 1;
  filesDropped = output<File[]>();
  imagesPasted = output<File[]>();

  isDragOver = signal(false);

  // Counts nested dragenter/dragleave pairs so child-element transitions don't
  // prematurely dismiss the overlay. The previous rect-based check was unreliable:
  // it left the overlay stuck whenever the drag was aborted outside the window
  // (clientX/Y arrive as 0,0, which is inside a full-window rect) or when the
  // browser silently dropped further drag events.
  private dragCounter = 0;
  private destroyRef = inject(DestroyRef);

  constructor() {
    // Safety-net: reset state if the drag is cancelled, lands on another window,
    // or the user switches focus away mid-drag. These are the cases where the
    // local dragleave/drop listeners are never called.
    const reset = (): void => {
      this.dragCounter = 0;
      if (this.isDragOver()) {
        this.isDragOver.set(false);
      }
    };

    // Capture-phase Escape handler: when the drop overlay is visible, Escape
    // should dismiss it without propagating to parent listeners
    // (e.g. instance-detail's window:keydown, which interprets Escape as
    // "interrupt busy instance" and can fall through to terminate the session).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && this.isDragOver()) {
        event.preventDefault();
        event.stopPropagation();
        // stopImmediatePropagation ensures no other capture-phase listener on
        // window sees this Escape either.
        event.stopImmediatePropagation();
        reset();
      }
    };

    window.addEventListener('blur', reset);
    window.addEventListener('dragend', reset, true);
    window.addEventListener('drop', reset, true);
    // Capture phase so we run before parent components' bubble-phase handlers.
    window.addEventListener('keydown', onKeyDown, true);

    this.destroyRef.onDestroy(() => {
      window.removeEventListener('blur', reset);
      window.removeEventListener('dragend', reset, true);
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('keydown', onKeyDown, true);
    });
  }

  @HostListener('dragenter', ['$event'])
  onDragEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter++;
    this.isDragOver.set(true);
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    // preventDefault is required for the drop event to fire at all.
    event.preventDefault();
    event.stopPropagation();
    // If we somehow missed the dragenter (e.g. drag started inside a child that
    // swallowed it), make sure the overlay still appears.
    if (!this.isDragOver()) {
      this.isDragOver.set(true);
    }
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter = Math.max(0, this.dragCounter - 1);
    if (this.dragCounter === 0) {
      this.isDragOver.set(false);
    }
  }

  // Output for file paths dragged from file explorer
  filePathDropped = output<string>();
  // Output for multiple file paths dragged from file explorer (multi-select)
  filePathsDropped = output<string[]>();
  // Output for folder paths dropped (directories cannot be attached as files)
  folderDropped = output<string>();

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter = 0;
    this.isDragOver.set(false);

    // Check for native file drop first
    const items = Array.from(event.dataTransfer?.items || []);
    const files = Array.from(event.dataTransfer?.files || []);

    if (files.length > 0) {
      // Check if any dropped item is a directory
      // In Electron/Chromium, we can detect directories via webkitGetAsEntry
      const actualFiles: File[] = [];
      const folderPaths: string[] = [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const file = files[i];

        if (item.webkitGetAsEntry) {
          const entry = item.webkitGetAsEntry();
          if (entry?.isDirectory) {
            // It's a directory - get its path from the File object
            // In Electron, File objects have a 'path' property
            const filePath = (file as File & { path?: string }).path;
            if (filePath) {
              folderPaths.push(filePath);
            }
            continue;
          }
        }

        // It's a regular file
        if (file) {
          actualFiles.push(file);
        }
      }

      // Emit folder paths
      for (const folderPath of folderPaths) {
        this.folderDropped.emit(folderPath);
      }

      // Emit actual files
      if (actualFiles.length > 0) {
        this.filesDropped.emit(actualFiles);
      }

      if (actualFiles.length > 0 || folderPaths.length > 0) {
        return;
      }
    }

    // Check for folder path from file explorer (dragged directories)
    const folderPath = event.dataTransfer?.getData('application/x-folder-path');
    if (folderPath) {
      this.folderDropped.emit(folderPath);
      return;
    }

    // Check for multiple file paths from file explorer (multi-select drag)
    const filePaths = event.dataTransfer?.getData('application/x-file-paths');
    if (filePaths) {
      try {
        const paths: string[] = JSON.parse(filePaths);
        if (paths.length > 0) {
          this.filePathsDropped.emit(paths);
          return;
        }
      } catch {
        // Fall through to single file path
      }
    }

    // Check for single file path from file explorer
    const filePath = event.dataTransfer?.getData('application/x-file-path');
    if (filePath) {
      this.filePathDropped.emit(filePath);
    }
  }

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          // Create a named file from the blob with a short, friendly name
          const ext = file.type.split('/')[1] || 'png';
          const namedFile = new File(
            [file],
            `pasted-image-${DropZoneComponent.pastedImageCounter++}.${ext}`,
            { type: file.type }
          );
          imageFiles.push(namedFile);
        }
      }
    }

    if (imageFiles.length > 0) {
      event.preventDefault();
      this.imagesPasted.emit(imageFiles);
    }
  }
}
