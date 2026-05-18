/**
 * Angular Application Entry Point
 */

import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

// Forward unhandled Promise rejections (outside Angular zone) to the
// main-process logger so they appear in diagnostics bundles. Angular's
// ErrorHandler covers zone-aware rejections; this catches the rest.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error('[Renderer] Unhandled Promise rejection:', reason);

  const win = window as unknown as {
    electronAPI?: {
      infrastructure?: {
        logMessage?: (
          level: string,
          msg: string,
          ctx?: string,
          meta?: unknown,
        ) => Promise<unknown>;
      };
    };
  };
  const logFn = win.electronAPI?.infrastructure?.logMessage;
  if (typeof logFn === 'function') {
    const message =
      reason instanceof Error
        ? reason.message
        : typeof reason === 'string'
          ? reason
          : 'Unhandled Promise rejection';
    void logFn('error', message, 'renderer:unhandledrejection', {
      name: reason instanceof Error ? reason.name : undefined,
      stack: reason instanceof Error ? reason.stack : undefined,
    }).catch(() => undefined);
  }
});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error('Bootstrap error:', err));
