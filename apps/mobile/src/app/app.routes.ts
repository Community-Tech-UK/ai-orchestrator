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
  {
    path: 'projects/:projectKey/sessions/:instanceId',
    loadComponent: () =>
      import('./features/conversation/conversation.component').then((m) => m.ConversationComponent),
  },
  {
    path: 'new-session',
    loadComponent: () =>
      import('./features/new-session/new-session.component').then((m) => m.NewSessionComponent),
  },
  {
    path: 'history',
    loadComponent: () =>
      import('./features/history/history.component').then((m) => m.HistoryComponent),
  },
  {
    path: 'history/:chatId',
    loadComponent: () =>
      import('./features/history/history-detail.component').then((m) => m.HistoryDetailComponent),
  },
  { path: '**', redirectTo: '' },
];
