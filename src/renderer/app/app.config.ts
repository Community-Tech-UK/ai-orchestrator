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

export const appConfig: ApplicationConfig = {
  providers: [
    // Angular 21: Zoneless change detection is now stable and the default
    provideZonelessChangeDetection(),

    // Router configuration
    provideRouter(routes),
  ],
};
