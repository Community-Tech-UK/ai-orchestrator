import { InjectionToken } from '@angular/core';

export interface ClipboardToastAdapter {
  success(text: string): void;
  error(text: string): void;
}

/**
 * Optional adapter for copy feedback. Call sites with their own inline state
 * should pass `{ silent: true }` to ClipboardService methods.
 */
export const CLIPBOARD_TOAST = new InjectionToken<ClipboardToastAdapter>('CLIPBOARD_TOAST');
