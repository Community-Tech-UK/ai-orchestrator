import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';

/**
 * Copies plain text to the system clipboard. Uses the native Capacitor
 * clipboard on iOS (works without focus/permission prompts inside the
 * WKWebView) and falls back to the web clipboard API in the dev build.
 */
@Injectable({ providedIn: 'root' })
export class ClipboardService {
  async copy(text: string): Promise<boolean> {
    if (!text) return false;
    try {
      if (Capacitor.isNativePlatform()) {
        await Clipboard.write({ string: text });
        return true;
      }
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
