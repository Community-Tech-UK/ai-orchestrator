import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { Clipboard } from '@capacitor/clipboard';
import type { MobileAttachmentDto } from './models';

/** Longest edge we downscale picked photos to before sending. */
const MAX_DIMENSION = 1600;
/** JPEG quality for the re-encoded image. */
const JPEG_QUALITY = 0.82;
/** How many photos a single pick can add. */
const MAX_PICK = 5;

/**
 * Picks photos from the camera roll and turns them into base64 data-URL
 * attachments the gateway's `sendInput` already accepts (`FileAttachment`).
 *
 * Every image is re-encoded through a canvas, downscaled to {@link MAX_DIMENSION}
 * and JPEG-compressed, so a multi-megabyte HEIC/PNG becomes a few hundred KB —
 * well under the gateway's 8 MB body cap — and HEIC is normalised to JPEG that
 * any provider can read. No-ops on the web/dev build.
 */
@Injectable({ providedIn: 'root' })
export class ImageAttachmentService {
  get available(): boolean {
    return Capacitor.isNativePlatform();
  }

  async pickImages(): Promise<MobileAttachmentDto[]> {
    if (!this.available) {
      return [];
    }
    const result = await Camera.pickImages({ quality: 90, limit: MAX_PICK });
    const out: MobileAttachmentDto[] = [];
    for (let i = 0; i < result.photos.length; i++) {
      const dto = await this.toAttachment(result.photos[i].webPath, i);
      if (dto) {
        out.push(dto);
      }
    }
    return out;
  }

  async pasteImageFromClipboard(): Promise<MobileAttachmentDto | null> {
    if (!this.available) {
      return null;
    }
    try {
      const result = await Clipboard.read();
      if (!this.isClipboardImage(result.type, result.value)) {
        return null;
      }
      return await this.dataUrlToAttachment(result.value, `clipboard-${Date.now()}.jpg`);
    } catch {
      return null;
    }
  }

  async attachmentsFromPasteEvent(event: ClipboardEvent): Promise<MobileAttachmentDto[]> {
    const files = this.imageFilesFromClipboard(event.clipboardData).slice(0, MAX_PICK);
    if (!files.length) {
      return [];
    }
    event.preventDefault();
    const out: MobileAttachmentDto[] = [];
    for (let i = 0; i < files.length; i++) {
      const dto = await this.blobToAttachment(files[i], this.toJpegName(files[i].name, i));
      if (dto) {
        out.push(dto);
      }
    }
    return out;
  }

  private async toAttachment(webPath: string | undefined, index: number): Promise<MobileAttachmentDto | null> {
    if (!webPath) {
      return null;
    }
    try {
      const blob = await (await fetch(webPath)).blob();
      return await this.blobToAttachment(blob, `photo-${Date.now()}-${index + 1}.jpg`);
    } catch {
      return null;
    }
  }

  private async dataUrlToAttachment(dataUrl: string, name: string): Promise<MobileAttachmentDto | null> {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      return await this.blobToAttachment(blob, name);
    } catch {
      return null;
    }
  }

  private async blobToAttachment(blob: Blob, name: string): Promise<MobileAttachmentDto | null> {
    try {
      const data = await this.downscaleToJpegDataUrl(blob);
      const base64 = data.slice(data.indexOf(',') + 1);
      return {
        name,
        type: 'image/jpeg',
        size: Math.round((base64.length * 3) / 4),
        data,
      };
    } catch {
      return null;
    }
  }

  private imageFilesFromClipboard(data: DataTransfer | null): File[] {
    if (!data) {
      return [];
    }
    const files = Array.from(data.files).filter((file) => file.type.startsWith('image/'));
    if (files.length) {
      return files;
    }
    return Array.from(data.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
  }

  private isClipboardImage(type: string, value: string): boolean {
    const normalizedType = type.toLowerCase();
    return (
      value.startsWith('data:image/') ||
      normalizedType === 'image' ||
      normalizedType.startsWith('image/')
    );
  }

  private toJpegName(name: string, index: number): string {
    if (!name.trim()) {
      return `pasted-image-${Date.now()}-${index + 1}.jpg`;
    }
    return name.replace(/\.[^.]*$/, '') + '.jpg';
  }

  private downscaleToJpegDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const longest = Math.max(img.width, img.height) || 1;
        const scale = Math.min(1, MAX_DIMENSION / longest);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas 2D context unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Image decode failed'));
      };
      img.src = url;
    });
  }
}
