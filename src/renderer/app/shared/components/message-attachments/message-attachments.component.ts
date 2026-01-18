/**
 * Message Attachments Component - Displays file attachments in chat messages
 *
 * Shows image thumbnails for images, file icons with names for other files.
 * Supports clicking to view/open files.
 */

import { Component, input, ChangeDetectionStrategy } from '@angular/core';

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
            <div class="image-thumbnail" (click)="openImage(attachment)">
              <img [src]="attachment.data" [alt]="attachment.name" />
              <div class="image-overlay">
                <span class="image-name">{{ attachment.name }}</span>
              </div>
            </div>
          } @else {
            <div class="file-attachment">
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
      max-width: 200px;
    }

    .image-thumbnail {
      position: relative;
      cursor: pointer;
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-secondary);

      &:hover .image-overlay {
        opacity: 1;
      }
    }

    .image-thumbnail img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 150px;
      object-fit: cover;
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
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageAttachmentsComponent {
  attachments = input.required<AttachmentDisplay[]>();

  isImage(attachment: AttachmentDisplay): boolean {
    return attachment.type.startsWith('image/');
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

  openImage(attachment: AttachmentDisplay): void {
    // Open image data URL in a new tab
    if (attachment.data) {
      window.open(attachment.data, '_blank');
    }
  }
}
