import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./features/hosts/hosts.component').then((m) => m.HostsComponent),
  },
  {
    path: 'add-host',
    loadComponent: () =>
      import('./features/hosts/add-host.component').then((m) => m.AddHostComponent),
  },
  {
    path: 'projects',
    loadComponent: () =>
      import('./features/projects/projects.component').then((m) => m.ProjectsComponent),
  },
  {
    path: 'projects/:projectKey/sessions',
    loadComponent: () =>
      import('./features/sessions/sessions.component').then((m) => m.SessionsComponent),
  },
  { path: '**', redirectTo: '' },
];
