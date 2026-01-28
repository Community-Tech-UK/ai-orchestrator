/**
 * Drop Zone Component - File drag & drop and image paste handler
 */

import {
  Component,
  output,
  signal,
  HostListener,
  ChangeDetectionStrategy,
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

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();

    // Check if we're actually leaving the drop zone
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = event.clientX;
    const y = event.clientY;

    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      this.isDragOver.set(false);
    }
  }

  // Output for file paths dragged from file explorer
  filePathDropped = output<string>();
  // Output for folder paths dropped (directories cannot be attached as files)
  folderDropped = output<string>();

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
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

    // Check for file path from file explorer
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
