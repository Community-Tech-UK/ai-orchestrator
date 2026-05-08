/**
 * Image Handlers - Clipboard copy and context menu for images
 *
 * Uses Electron's nativeImage + clipboard for proper native image copy,
 * and Menu for right-click context menu on images.
 */

import { ipcMain, clipboard, nativeImage, Menu, dialog, BrowserWindow } from 'electron';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import {
  ImageResolveRequestSchema,
  ImageResolveResponseSchema,
} from '@contracts/schemas/image';
import { getImageResolver } from '../../services/image-resolver';
import { validatedHandler } from '../validated-handler';

const ImageCopyPayloadSchema = z.object({
  dataUrl: z.string().startsWith('data:'),
});

const ImageContextMenuPayloadSchema = z.object({
  dataUrl: z.string().startsWith('data:'),
  filename: z.string().min(1),
});

const ImageCopyMessagePayloadSchema = z.object({
  /** Plain-text representation of the message body. */
  text: z.string(),
  /**
   * Optional rich HTML representation (typically the message text plus
   * inline `<img>` tags for each attachment). Pasted into rich-text
   * targets like Slack, email clients, and Notes so both text and
   * images survive the round-trip.
   */
  html: z.string().optional(),
  /**
   * Optional first image (PNG/JPEG data URL) for paste targets that
   * accept only an image (Photoshop, Preview, image-paste boxes).
   * The renderer must convert non-PNG/JPEG data URLs (WebP, GIF, …)
   * before sending — `nativeImage.createFromDataURL` only accepts PNG/JPEG.
   */
  imageDataUrl: z
    .string()
    .startsWith('data:')
    .optional(),
});

function copyImageFromDataUrl(dataUrl: string): void {
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    throw new Error('Failed to create image from data URL');
  }
  clipboard.writeImage(image);
}

export function registerImageHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_RESOLVE,
    validatedHandler(
      'IMAGE_RESOLVE',
      ImageResolveRequestSchema,
      async (validated): Promise<IpcResponse> => {
        const resolved = await getImageResolver().resolve(validated);
        return {
          success: true,
          data: ImageResolveResponseSchema.parse(resolved),
        };
      }
    )
  );

  // Copy image to system clipboard as native image
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_COPY_TO_CLIPBOARD,
    validatedHandler(
      'IMAGE_COPY_TO_CLIPBOARD',
      ImageCopyPayloadSchema,
      async (validated): Promise<IpcResponse> => {
        copyImageFromDataUrl(validated.dataUrl);
        return { success: true };
      }
    )
  );

  // Copy a chat-message-shaped payload to the system clipboard as a
  // multi-format entry: text + HTML + image (when present). Lets a single
  // copy round-trip both prose and inline images, so pasting into Slack /
  // email / docs preserves images via HTML, while pasting into Photoshop
  // or an image-only box pastes the first image natively.
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_COPY_MESSAGE,
    validatedHandler(
      'IMAGE_COPY_MESSAGE',
      ImageCopyMessagePayloadSchema,
      async (validated): Promise<IpcResponse> => {
        const data: Electron.Data = { text: validated.text };
        if (validated.html !== undefined && validated.html.length > 0) {
          data.html = validated.html;
        }
        if (validated.imageDataUrl) {
          const image = nativeImage.createFromDataURL(validated.imageDataUrl);
          if (!image.isEmpty()) {
            data.image = image;
          }
        }
        clipboard.write(data);
        return { success: true };
      }
    )
  );

  // Show native context menu for an image
  ipcMain.handle(
    IPC_CHANNELS.IMAGE_CONTEXT_MENU,
    validatedHandler(
      'IMAGE_CONTEXT_MENU',
      ImageContextMenuPayloadSchema,
      async (validated, event): Promise<IpcResponse> => {
        const { dataUrl, filename } = validated;
        const win = BrowserWindow.fromWebContents(event.sender);

        return new Promise<IpcResponse>((resolve) => {
          const menu = Menu.buildFromTemplate([
            {
              label: 'Copy Image',
              click: () => {
                try {
                  copyImageFromDataUrl(dataUrl);
                  resolve({ success: true, data: { action: 'copy' } });
                } catch (error) {
                  resolve({
                    success: false,
                    error: {
                      code: 'COPY_FAILED',
                      message: (error as Error).message,
                      timestamp: Date.now(),
                    },
                  });
                }
              },
            },
            {
              label: 'Save Image As\u2026',
              click: async () => {
                try {
                  const ext = path.extname(filename) || '.png';
                  const nameNoExt = path.basename(filename, ext);
                  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getFocusedWindow()!, {
                    defaultPath: filename,
                    filters: [
                      { name: `${ext.slice(1).toUpperCase()} Image`, extensions: [ext.slice(1)] },
                      { name: nameNoExt, extensions: [ext.slice(1)] },
                    ],
                  });

                  if (!result.canceled && result.filePath) {
                    // Extract binary data from base64 data URL
                    const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
                    if (!base64Match) {
                      throw new Error('Invalid data URL format');
                    }
                    const buffer = Buffer.from(base64Match[1], 'base64');
                    fs.writeFileSync(result.filePath, buffer);
                    resolve({ success: true, data: { action: 'save', filePath: result.filePath } });
                  } else {
                    resolve({ success: true, data: { action: 'cancelled' } });
                  }
                } catch (error) {
                  resolve({
                    success: false,
                    error: {
                      code: 'SAVE_FAILED',
                      message: (error as Error).message,
                      timestamp: Date.now(),
                    },
                  });
                }
              },
            },
          ]);

          menu.popup({
            window: win ?? undefined,
            callback: () => {
              // Menu closed without selecting an item
              resolve({ success: true, data: { action: 'dismissed' } });
            },
          });
        });
      }
    )
  );
}
