import { Routes } from '@angular/router';

export const PLAN_QUEUE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./plan-queue-page.component').then((m) => m.PlanQueuePageComponent),
  },
];
