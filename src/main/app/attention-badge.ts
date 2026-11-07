import { app, BrowserWindow, nativeImage } from 'electron';
import { getLogger } from '../logging/logger';
import { registerCleanup } from '../util/cleanup-registry';

const logger = getLogger('AttentionBadge');

export class AttentionBadge {
  private static instance: AttentionBadge | null = null;
  private count = 0;
  private windowProvider: () => BrowserWindow | null = () => null;
  private readonly reapply = () => this.apply();
  private readonly unregister = registerCleanup(() => this.destroy());

  static getInstance(): AttentionBadge { return this.instance ??= new AttentionBadge(); }
  static _resetForTesting(): void {
    this.instance?.destroy(); this.instance = null;
  }
  private constructor() {
    app.on('browser-window-focus', this.reapply);
    app.on('browser-window-blur', this.reapply);
  }
  setWindowProvider(provider: () => BrowserWindow | null): void { this.windowProvider = provider; }
  setCount(count: number): void { this.count = Math.max(0, Math.min(9999, Math.trunc(count))); this.apply(); }
  private destroy(): void {
    this.setCount(0);
    this.unregister();
    app.removeListener('browser-window-focus', this.reapply);
    app.removeListener('browser-window-blur', this.reapply);
  }
  private apply(): void {
    const count = BrowserWindow.getFocusedWindow() ? 0 : this.count;
    try {
      if (process.platform === 'win32') {
        const window = this.windowProvider();
        if (window && !window.isDestroyed()) window.setOverlayIcon(count ? redDot() : null, count ? `${count} ${count === 1 ? 'thing needs' : 'things need'} you` : '');
      } else if (!app.setBadgeCount(count) && process.platform === 'darwin') {
        app.dock?.setBadge(count ? String(count) : '');
      }
    } catch { logger.warn('Could not update attention badge'); }
  }
}

function redDot(): Electron.NativeImage {
  const pixels = Buffer.alloc(16 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 49) continue;
    const offset = (y * 16 + x) * 4;
    pixels[offset] = 56; pixels[offset + 1] = 56; pixels[offset + 2] = 224; pixels[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width: 16, height: 16 });
}
export const getAttentionBadge = (): AttentionBadge => AttentionBadge.getInstance();
