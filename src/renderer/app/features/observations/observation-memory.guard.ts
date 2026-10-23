import { inject } from '@angular/core';
import { Router, type CanMatchFn } from '@angular/router';
import { SettingsStore } from '../../core/state/settings.store';

export const observationMemoryGuard: CanMatchFn = async () => {
  const settings = inject(SettingsStore);
  const router = inject(Router);
  await settings.initialize();
  return settings.settings().observationMemoryEnabled === true || router.parseUrl('/knowledge');
};
