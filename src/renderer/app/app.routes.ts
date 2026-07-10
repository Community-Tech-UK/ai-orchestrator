/**
 * Application Routes
 *
 * Primary app routes stay top-level. Secondary app surfaces are wrapped in the
 * Control Center shell so route-level Back/navigation chrome is guaranteed.
 */

import { Routes } from '@angular/router';

import { controlSurfaceRouteData } from './shared/control-surface/control-surface-route-data';

const controlSurfaceRoutes: Routes = [
  {
    path: 'settings',
    data: controlSurfaceRouteData('settings'),
    loadComponent: () =>
      import('./features/settings/settings.component').then((m) => m.SettingsComponent),
  },
  {
    path: 'chat-search',
    data: controlSurfaceRouteData('chat-search'),
    loadComponent: () =>
      import('./features/chat-search/chat-search-page.component').then((m) => m.ChatSearchPageComponent),
  },
  {
    path: 'automations',
    data: controlSurfaceRouteData('automations'),
    loadComponent: () =>
      import('./features/automations/automations-page.component').then((m) => m.AutomationsPageComponent),
  },
  {
    path: 'campaigns',
    data: controlSurfaceRouteData('campaigns'),
    loadChildren: () =>
      import('./features/campaign/campaign.routes').then((m) => m.CAMPAIGN_ROUTES),
  },
  {
    path: 'workflows',
    data: controlSurfaceRouteData('workflows'),
    loadComponent: () =>
      import('./features/workflow/workflow-page.component').then((m) => m.WorkflowPageComponent),
  },
  {
    path: 'hooks',
    data: controlSurfaceRouteData('hooks'),
    loadComponent: () =>
      import('./features/hooks/hooks-page.component').then((m) => m.HooksPageComponent),
  },
  {
    path: 'skills',
    data: controlSurfaceRouteData('skills'),
    loadComponent: () =>
      import('./features/skills/skills-page.component').then((m) => m.SkillsPageComponent),
  },
  {
    path: 'reviews',
    data: controlSurfaceRouteData('reviews'),
    loadComponent: () =>
      import('./features/review/reviews-page.component').then((m) => m.ReviewsPageComponent),
  },
  {
    path: 'doc-review',
    data: controlSurfaceRouteData('doc-review'),
    loadComponent: () =>
      import('./features/doc-review/doc-review-page.component').then((m) => m.DocReviewPageComponent),
  },
  {
    path: 'specialists',
    data: controlSurfaceRouteData('specialists'),
    loadComponent: () =>
      import('./features/specialists/specialists-page.component').then((m) => m.SpecialistsPageComponent),
  },
  {
    path: 'worktrees',
    data: controlSurfaceRouteData('worktrees'),
    loadComponent: () =>
      import('./features/worktree/worktree-page.component').then((m) => m.WorktreePageComponent),
  },
  {
    path: 'supervision',
    data: controlSurfaceRouteData('supervision'),
    loadComponent: () =>
      import('./features/supervision/supervision-page.component').then((m) => m.SupervisionPageComponent),
  },
  {
    path: 'rlm',
    data: controlSurfaceRouteData('rlm'),
    loadComponent: () =>
      import('./features/rlm/rlm-page.component').then((m) => m.RlmPageComponent),
  },
  {
    path: 'training',
    data: controlSurfaceRouteData('training'),
    loadComponent: () =>
      import('./features/training/training-page.component').then((m) => m.TrainingPageComponent),
  },
  {
    path: 'memory',
    data: controlSurfaceRouteData('memory'),
    loadComponent: () =>
      import('./features/memory/memory-page.component').then((m) => m.MemoryPageComponent),
  },
  {
    path: 'memory/stats',
    data: controlSurfaceRouteData('memory-stats'),
    loadComponent: () =>
      import('./features/memory/memory-stats.component').then((m) => m.MemoryStatsComponent),
  },
  {
    path: 'debate',
    data: controlSurfaceRouteData('debate'),
    loadComponent: () =>
      import('./features/debate/debate-page.component').then((m) => m.DebatePageComponent),
  },
  {
    path: 'verification',
    data: controlSurfaceRouteData('verification'),
    loadComponent: () =>
      import('./features/verification/dashboard/verification-dashboard.component')
        .then((m) => m.VerificationDashboardComponent),
  },
  {
    path: 'verification/settings',
    data: controlSurfaceRouteData('verification-settings'),
    loadComponent: () =>
      import('./features/verification/config/cli-settings-panel.component')
        .then((m) => m.CliSettingsPanelComponent),
  },
  {
    path: 'lsp',
    data: controlSurfaceRouteData('lsp'),
    loadComponent: () =>
      import('./features/lsp/lsp-page.component').then((m) => m.LspPageComponent),
  },
  {
    path: 'mcp',
    data: controlSurfaceRouteData('mcp'),
    loadComponent: () =>
      import('./features/mcp/mcp-page.component').then((m) => m.McpPageComponent),
  },
  {
    path: 'browser',
    data: controlSurfaceRouteData('browser'),
    loadComponent: () =>
      import('./features/browser/browser-page.component').then((m) => m.BrowserPageComponent),
  },
  {
    path: 'vcs',
    data: controlSurfaceRouteData('vcs'),
    loadComponent: () =>
      import('./features/vcs/vcs-page.component').then((m) => m.VcsPageComponent),
  },
  {
    path: 'tasks',
    data: controlSurfaceRouteData('tasks'),
    loadComponent: () =>
      import('./features/tasks/tasks-page.component').then((m) => m.TasksPageComponent),
  },
  {
    path: 'plan',
    data: controlSurfaceRouteData('plan'),
    loadComponent: () =>
      import('./features/plan/plan-page.component').then((m) => m.PlanPageComponent),
  },
  {
    path: 'stats',
    data: controlSurfaceRouteData('stats'),
    loadComponent: () =>
      import('./features/stats/stats-page.component').then((m) => m.StatsPageComponent),
  },
  {
    path: 'cost',
    data: controlSurfaceRouteData('cost'),
    loadComponent: () =>
      import('./features/cost/cost-page.component').then((m) => m.CostPageComponent),
  },
  {
    path: 'snapshots',
    data: controlSurfaceRouteData('snapshots'),
    loadComponent: () =>
      import('./features/snapshots/snapshot-page.component').then((m) => m.SnapshotPageComponent),
  },
  {
    path: 'replay',
    data: controlSurfaceRouteData('replay'),
    loadComponent: () =>
      import('./features/replay/session-replay-page.component').then((m) => m.SessionReplayPageComponent),
  },
  {
    path: 'remote-access',
    data: controlSurfaceRouteData('remote-access'),
    loadComponent: () =>
      import('./features/remote-access/remote-access-page.component').then((m) => m.RemoteAccessPageComponent),
  },
  {
    path: 'search',
    data: controlSurfaceRouteData('search'),
    loadComponent: () =>
      import('./features/codebase/codebase-page.component').then((m) => m.CodebasePageComponent),
  },
  {
    path: 'security',
    data: controlSurfaceRouteData('security'),
    loadComponent: () =>
      import('./features/security/security-page.component').then((m) => m.SecurityPageComponent),
  },
  {
    path: 'logs',
    data: controlSurfaceRouteData('logs'),
    loadComponent: () =>
      import('./features/logs/logs-page.component').then((m) => m.LogsPageComponent),
  },
  {
    path: 'observations',
    data: controlSurfaceRouteData('observations'),
    loadComponent: () =>
      import('./features/observations/observations-page.component').then((m) => m.ObservationsPageComponent),
  },
  {
    path: 'knowledge',
    data: controlSurfaceRouteData('knowledge'),
    loadComponent: () =>
      import('./features/knowledge/knowledge-page.component').then((m) => m.KnowledgePageComponent),
  },
  {
    path: 'plugins',
    data: controlSurfaceRouteData('plugins'),
    loadComponent: () =>
      import('./features/plugins/plugins-page.component').then((m) => m.PluginsPageComponent),
  },
  {
    path: 'models',
    data: controlSurfaceRouteData('models'),
    loadComponent: () =>
      import('./features/models/models-page.component').then((m) => m.ModelsPageComponent),
  },
  {
    path: 'remote-config',
    data: controlSurfaceRouteData('remote-config'),
    loadComponent: () =>
      import('./features/remote-config/remote-config-page.component').then((m) => m.RemoteConfigPageComponent),
  },
  {
    path: 'communication',
    data: controlSurfaceRouteData('communication'),
    loadComponent: () =>
      import('./features/communication/communication-page.component').then((m) => m.CommunicationPageComponent),
  },
  {
    path: 'multi-edit',
    data: controlSurfaceRouteData('multi-edit'),
    loadComponent: () =>
      import('./features/multi-edit/multi-edit-page.component').then((m) => m.MultiEditPageComponent),
  },
  {
    path: 'editor',
    data: controlSurfaceRouteData('editor'),
    loadComponent: () =>
      import('./features/editor/editor-page.component').then((m) => m.EditorPageComponent),
  },
  {
    path: 'archive',
    data: controlSurfaceRouteData('archive'),
    loadComponent: () =>
      import('./features/archive/archive-page.component').then((m) => m.ArchivePageComponent),
  },
  {
    path: 'semantic-search',
    data: controlSurfaceRouteData('semantic-search'),
    loadComponent: () =>
      import('./features/semantic-search/semantic-search-page.component')
        .then((m) => m.SemanticSearchPageComponent),
  },
  {
    path: 'channels',
    data: controlSurfaceRouteData('channels'),
    loadChildren: () =>
      import('./features/channels/channels.routes').then((m) => m.CHANNELS_ROUTES),
  },
  {
    path: 'remote-nodes',
    data: controlSurfaceRouteData('remote-nodes'),
    loadComponent: () =>
      import('./features/remote-nodes/remote-nodes-page.component').then((m) => m.RemoteNodesPageComponent),
  },
  {
    path: 'ask-council',
    data: controlSurfaceRouteData('ask-council'),
    loadComponent: () =>
      import('./features/compare/ask-council-page.component').then((m) => m.AskCouncilPageComponent),
  },
  {
    path: 'fleet',
    data: controlSurfaceRouteData('fleet'),
    loadComponent: () =>
      import('./features/fleet-dashboard/fleet-dashboard.component').then((m) => m.FleetDashboardComponent),
  },
  {
    path: 'compare/split',
    data: controlSurfaceRouteData('compare-split'),
    loadComponent: () =>
      import('./features/compare/split-session-compare.component')
        .then((m) => m.SplitSessionCompareComponent),
  },
];

export const routes: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: '',
    loadComponent: () =>
      import('./shared/control-surface/control-surface-shell.component')
        .then((m) => m.ControlSurfaceShellComponent),
    children: controlSurfaceRoutes,
  },
  {
    path: 'operator',
    redirectTo: '',
  },
  {
    path: 'setup',
    loadComponent: () =>
      import('./features/setup/setup-center.component').then((m) => m.SetupCenterComponent),
  },
  {
    path: '**',
    redirectTo: '',
  },
];
