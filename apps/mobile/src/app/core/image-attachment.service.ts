import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
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

  private async toAttachment(webPath: string | undefined, index: number): Promise<MobileAttachmentDto | null> {
    if (!webPath) {
      return null;
    }
    try {
      const blob = await (await fetch(webPath)).blob();
      const data = await this.downscaleToJpegDataUrl(blob);
      const base64 = data.slice(data.indexOf(',') + 1);
      return {
        name: `photo-${Date.now()}-${index + 1}.jpg`,
        type: 'image/jpeg',
        size: Math.round((base64.length * 3) / 4),
        data,
      };
    } catch {
      return null;
    }
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
