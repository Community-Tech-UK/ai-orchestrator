/**
 * Angular Application Configuration
 * Configures zoneless change detection and providers
 */

import {
  ApplicationConfig,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { CLIPBOARD_TOAST } from './core/services/clipboard-toast.token';
import { ToastService } from './core/services/toast.service';
import { RendererErrorHandler } from './core/services/renderer-error-handler';
import { RendererHeartbeatService } from './core/services/renderer-heartbeat.service';

export const appConfig: ApplicationConfig = {
  providers: [
    // Angular 21: Zoneless change detection is now stable and the default
    provideZonelessChangeDetection(),

    // Router configuration
    provideRouter(routes),

    // Global error handler — forwards uncaught Angular errors to the
    // main-process logger so crashes appear in diagnostics bundles.
    { provide: ErrorHandler, useClass: RendererErrorHandler },

    // Freeze-detection heartbeat: main logs a stall when beats stop while the
    // renderer process is still alive.
    provideAppInitializer(() => {
      inject(RendererHeartbeatService).start();
    }),

    {
      provide: CLIPBOARD_TOAST,
      useFactory: (toast: ToastService) => ({
        success: (text: string) => toast.show(text, 'success'),
        error: (text: string) => toast.show(text, 'error'),
      }),
      deps: [ToastService],
    },
  ],
};
