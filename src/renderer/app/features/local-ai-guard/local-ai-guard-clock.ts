import { InjectionToken } from '@angular/core';

export const LOCAL_AI_GUARD_CLOCK = new InjectionToken<() => number>(
  'LOCAL_AI_GUARD_CLOCK',
  { providedIn: 'root', factory: () => Date.now },
);
