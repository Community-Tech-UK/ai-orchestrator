/**
 * Angular Application Configuration
 * Configures zoneless change detection and providers
 */

import {
  ApplicationConfig,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { CLIPBOARD_TOAST } from './core/services/clipboard-toast.token';
import { ToastService } from './core/services/toast.service';

export const appConfig: ApplicationConfig = {
  providers: [
    // Angular 21: Zoneless change detection is now stable and the default
    provideZonelessChangeDetection(),

    // Router configuration
    provideRouter(routes),

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
