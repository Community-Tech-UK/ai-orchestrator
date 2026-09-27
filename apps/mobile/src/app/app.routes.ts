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
    path: 'inbox',
    loadComponent: () =>
      import('./features/inbox/inbox.component').then((m) => m.InboxComponent),
  },
  {
    path: 'automations',
    loadComponent: () =>
      import('./features/automations/automations.component').then((m) => m.AutomationsComponent),
  },
  {
    path: 'loops',
    loadComponent: () => import('./features/loops/loops.component').then((m) => m.LoopsComponent),
  },
  {
    path: 'loops/:id',
    loadComponent: () =>
      import('./features/loops/loop-detail.component').then((m) => m.LoopDetailComponent),
  },
  {
    path: 'plan-queue',
    loadComponent: () =>
      import('./features/plan-queue/plan-queue.component').then((m) => m.PlanQueueComponent),
  },
  {
    path: 'plan-queue/:id',
    loadComponent: () =>
      import('./features/plan-queue/plan-queue-detail.component').then((m) => m.PlanQueueDetailComponent),
  },
  {
    path: 'reviews',
    loadComponent: () =>
      import('./features/doc-review/doc-reviews.component').then((m) => m.DocReviewsComponent),
  },
  {
    path: 'reviews/:id',
    loadComponent: () =>
      import('./features/doc-review/doc-review-detail.component').then((m) => m.DocReviewDetailComponent),
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
