/**
 * Message Attachments Component - Displays file attachments in chat messages
 *
 * Shows image thumbnails for images, file icons with names for other files.
 * Supports clicking to view/open files.
 */

import { Component, input, signal, ChangeDetectionStrategy } from '@angular/core';

export interface AttachmentDisplay {
  name: string;
  type: string;
  size: number;
  data?: string; // base64 data URL for images
}

@Component({
  selector: 'app-message-attachments',
  standalone: true,
  template: `
    <div class="attachments-container">
      @for (attachment of attachments(); track attachment.name) {
        <div class="attachment" [class.image-attachment]="isImage(attachment)">
          @if (isImage(attachment) && attachment.data) {
            <div class="image-thumbnail" (click)="openPreview(attachment)" [style.background-image]="'url(' + attachment.data + ')'">
              <div class="image-overlay">
                <span class="image-name">{{ attachment.name }}</span>
              </div>
            </div>
          } @else if (isImage(attachment)) {
            <!-- Fallback for images with no data -->
            <div class="file-attachment clickable" (click)="openPreview(attachment)">
              <div class="file-icon">🖼️</div>
              <div class="file-info">
                <span class="file-name">{{ attachment.name }}</span>
                <span class="file-size">{{ formatSize(attachment.size) }}</span>
              </div>
            </div>
          } @else {
            <div class="file-attachment clickable" (click)="openFile(attachment)">
              <div class="file-icon">{{ getFileIcon(attachment) }}</div>
              <div class="file-info">
                <span class="file-name">{{ attachment.name }}</span>
                <span class="file-size">{{ formatSize(attachment.size) }}</span>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Image preview modal -->
    @if (previewAttachment()) {
      <div class="preview-overlay" (click)="closePreview()">
        <div class="preview-content" (click)="$event.stopPropagation()">
          <div class="preview-header">
            <span class="preview-title">{{ previewAttachment()!.name }}</span>
            <button class="preview-close" (click)="closePreview()">×</button>
          </div>
          <div class="preview-body">
            @if (isImage(previewAttachment()!)) {
              <img [src]="previewAttachment()!.data" [alt]="previewAttachment()!.name" />
            } @else if (isText(previewAttachment()!)) {
              <pre class="preview-text">{{ decodeTextContent(previewAttachment()!.data) }}</pre>
            } @else {
              <div class="preview-unsupported">
                <div class="preview-icon">{{ getFileIcon(previewAttachment()!) }}</div>
                <p>Preview not available for this file type</p>
                <p class="preview-size">{{ formatSize(previewAttachment()!.size) }}</p>
              </div>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .attachments-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .attachment {
      border-radius: 8px;
      overflow: hidden;
    }

    .image-attachment {
      max-width: 120px;
    }

    .image-thumbnail {
      position: relative;
      cursor: pointer;
      border-radius: 6px;
      overflow: hidden;
      background-color: var(--bg-secondary);
      background-size: cover;
      background-position: center;
      background-repeat: no-repeat;
      width: 120px;
      height: 90px;

      &:hover .image-overlay {
        opacity: 1;
      }
    }

    .image-overlay {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      background: linear-gradient(transparent, rgba(0, 0, 0, 0.7));
      padding: 8px;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    .image-name {
      color: white;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    .file-attachment {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      min-width: 150px;
      max-width: 250px;
    }

    .message-user .file-attachment {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .file-icon {
      font-size: 24px;
      flex-shrink: 0;
    }

    .file-info {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .file-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .file-size {
      font-size: 11px;
      opacity: 0.7;
    }

    .file-attachment.clickable {
      cursor: pointer;
      transition: all 0.2s ease;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--primary-color);
      }
    }

    /* Preview modal styles */
    .preview-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 24px;
    }

    .preview-content {
      background: var(--bg-primary);
      border-radius: 12px;
      max-width: 90vw;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }

    .preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .preview-title {
      font-weight: 500;
      font-size: 14px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .preview-close {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      font-size: 20px;
      color: var(--text-secondary);
      background: transparent;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .preview-body {
      flex: 1;
      overflow: auto;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }

    .preview-body img {
      max-width: 100%;
      max-height: 80vh;
      object-fit: contain;
      border-radius: 8px;
    }

    .preview-text {
      width: 100%;
      max-width: 800px;
      padding: 16px;
      background: var(--bg-secondary);
      border-radius: 8px;
      font-family: var(--font-mono);
      font-size: 13px;
      line-height: 1.5;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text-primary);
    }

    .preview-unsupported {
      text-align: center;
      color: var(--text-secondary);
      padding: 48px;
    }

    .preview-icon {
      font-size: 64px;
      margin-bottom: 16px;
    }

    .preview-size {
      font-size: 12px;
      opacity: 0.7;
      margin-top: 8px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageAttachmentsComponent {
  attachments = input.required<AttachmentDisplay[]>();
  previewAttachment = signal<AttachmentDisplay | null>(null);

  isImage(attachment: AttachmentDisplay): boolean {
    return attachment.type.startsWith('image/');
  }

  isText(attachment: AttachmentDisplay): boolean {
    const type = attachment.type.toLowerCase();
    return type.startsWith('text/') ||
           type.includes('json') ||
           type.includes('javascript') ||
           type.includes('typescript') ||
           type.includes('xml') ||
           type.includes('yaml') ||
           type.includes('markdown');
  }

  getFileIcon(attachment: AttachmentDisplay): string {
    const type = attachment.type.toLowerCase();
    if (type.startsWith('image/')) return '🖼️';
    if (type.includes('pdf')) return '📄';
    if (type.includes('text')) return '📝';
    if (type.includes('json') || type.includes('javascript') || type.includes('typescript')) return '📋';
    if (type.includes('zip') || type.includes('archive') || type.includes('tar') || type.includes('gz')) return '📦';
    if (type.includes('video')) return '🎬';
    if (type.includes('audio')) return '🎵';
    if (type.includes('spreadsheet') || type.includes('excel') || type.includes('csv')) return '📊';
    if (type.includes('word') || type.includes('document')) return '📃';
    return '📎';
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  openPreview(attachment: AttachmentDisplay): void {
    if (attachment.data) {
      this.previewAttachment.set(attachment);
    }
  }

  openFile(attachment: AttachmentDisplay): void {
    // For files with data, open preview modal
    if (attachment.data) {
      this.previewAttachment.set(attachment);
    }
  }

  closePreview(): void {
    this.previewAttachment.set(null);
  }

  decodeTextContent(data?: string): string {
    if (!data) return '';
    // Data URL format: data:mime/type;base64,content
    const base64Match = data.match(/base64,(.+)/);
    if (base64Match) {
      try {
        return atob(base64Match[1]);
      } catch {
        return 'Unable to decode file content';
      }
    }
    return data;
  }
}
