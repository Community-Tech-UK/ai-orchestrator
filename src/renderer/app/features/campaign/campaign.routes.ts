import { Routes } from '@angular/router';

export const CAMPAIGN_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./campaign-page.component').then((m) => m.CampaignPageComponent),
  },
];
