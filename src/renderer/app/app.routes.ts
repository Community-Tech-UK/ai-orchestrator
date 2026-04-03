/**
 * Application Routes
 *
 * Main routes for the application including Phase 6-9 feature components:
 * - Workflows, Hooks, Skills (Phase 6)
 * - Specialists, Worktrees, Supervision (Phase 7)
 * - Memory Browser (Phase 8-9)
 * - Review Results (Phase 6)
 */

import { Routes } from '@angular/router';

export const routes: Routes = [
  // Default dashboard
  {
    path: '',
    loadComponent: () =>
      import('./features/dashboard/dashboard.component').then(
        (m) => m.DashboardComponent
      ),
  },

  // Settings
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings.component').then(
        (m) => m.SettingsComponent
      ),
  },

  // Phase 6: Workflows
  {
    path: 'workflows',
    loadComponent: () =>
      import('./features/workflow/workflow-page.component').then(
        (m) => m.WorkflowPageComponent
      ),
  },

  // Phase 6: Hooks Configuration
  {
    path: 'hooks',
    loadComponent: () =>
      import('./features/hooks/hooks-page.component').then(
        (m) => m.HooksPageComponent
      ),
  },

  // Phase 6: Skills Browser
  {
    path: 'skills',
    loadComponent: () =>
      import('./features/skills/skills-page.component').then(
        (m) => m.SkillsPageComponent
      ),
  },

  // Phase 6: Review Results
  {
    path: 'reviews',
    loadComponent: () =>
      import('./features/review/reviews-page.component').then(
        (m) => m.ReviewsPageComponent
      ),
  },

  // Phase 7: Specialists Picker
  {
    path: 'specialists',
    loadComponent: () =>
      import('./features/specialists/specialists-page.component').then(
        (m) => m.SpecialistsPageComponent
      ),
  },

  // Phase 7: Worktree Panel
  {
    path: 'worktrees',
    loadComponent: () =>
      import('./features/worktree/worktree-page.component').then(
        (m) => m.WorktreePageComponent
      ),
  },

  // Phase 7: Supervision Tree View
  {
    path: 'supervision',
    loadComponent: () =>
      import('./features/supervision/supervision-page.component').then(
        (m) => m.SupervisionPageComponent
      ),
  },

  // Phase 8: RLM Context Browser
  {
    path: 'rlm',
    loadComponent: () =>
      import('./features/rlm/rlm-page.component').then(
        (m) => m.RlmPageComponent
      ),
  },

  // Phase 8: GRPO Training Dashboard
  {
    path: 'training',
    loadComponent: () =>
      import('./features/training/training-page.component').then(
        (m) => m.TrainingPageComponent
      ),
  },

  // Phase 9: Memory Browser
  {
    path: 'memory',
    loadComponent: () =>
      import('./features/memory/memory-page.component').then(
        (m) => m.MemoryPageComponent
      ),
  },

  // Phase 9: Memory Stats
  {
    path: 'memory/stats',
    loadComponent: () =>
      import('./features/memory/memory-stats.component').then(
        (m) => m.MemoryStatsComponent
      ),
  },

  // Phase 9: Debate Visualization
  {
    path: 'debate',
    loadComponent: () =>
      import('./features/debate/debate-page.component').then(
        (m) => m.DebatePageComponent
      ),
  },

  // Multi-Agent Verification
  {
    path: 'verification',
    loadComponent: () =>
      import('./features/verification/dashboard/verification-dashboard.component').then(
        (m) => m.VerificationDashboardComponent
      ),
  },

  // Verification: CLI Settings
  {
    path: 'verification/settings',
    loadComponent: () =>
      import('./features/verification/config/cli-settings-panel.component').then(
        (m) => m.CliSettingsPanelComponent
      ),
  },

  // Sprint 2: LSP Integration
  {
    path: 'lsp',
    loadComponent: () =>
      import('./features/lsp/lsp-page.component').then(
        (m) => m.LspPageComponent
      ),
  },

  // Sprint 2: MCP Server Management
  {
    path: 'mcp',
    loadComponent: () =>
      import('./features/mcp/mcp-page.component').then(
        (m) => m.McpPageComponent
      ),
  },

  // Sprint 2: VCS/Git Operations
  {
    path: 'vcs',
    loadComponent: () =>
      import('./features/vcs/vcs-page.component').then(
        (m) => m.VcsPageComponent
      ),
  },

  // Background repo jobs
  {
    path: 'tasks',
    loadComponent: () =>
      import('./features/tasks/tasks-page.component').then(
        (m) => m.TasksPageComponent
      ),
  },

  // Sprint 2: Plan Mode
  {
    path: 'plan',
    loadComponent: () =>
      import('./features/plan/plan-page.component').then(
        (m) => m.PlanPageComponent
      ),
  },

  // Sprint 2: Statistics & Metrics
  {
    path: 'stats',
    loadComponent: () =>
      import('./features/stats/stats-page.component').then(
        (m) => m.StatsPageComponent
      ),
  },

  // Sprint 1: Cost Tracking
  {
    path: 'cost',
    loadComponent: () =>
      import('./features/cost/cost-page.component').then(
        (m) => m.CostPageComponent
      ),
  },

  // Sprint 1: Snapshot/Revert
  {
    path: 'snapshots',
    loadComponent: () =>
      import('./features/snapshots/snapshot-page.component').then(
        (m) => m.SnapshotPageComponent
      ),
  },

  // Session replay / observer
  {
    path: 'replay',
    loadComponent: () =>
      import('./features/replay/session-replay-page.component').then(
        (m) => m.SessionReplayPageComponent
      ),
  },
  {
    path: 'remote-access',
    loadComponent: () =>
      import('./features/remote-access/remote-access-page.component').then(
        (m) => m.RemoteAccessPageComponent
      ),
  },

  // Sprint 1: Codebase Search
  {
    path: 'search',
    loadComponent: () =>
      import('./features/codebase/codebase-page.component').then(
        (m) => m.CodebasePageComponent
      ),
  },

  // Sprint 1: Security & Audit
  {
    path: 'security',
    loadComponent: () =>
      import('./features/security/security-page.component').then(
        (m) => m.SecurityPageComponent
      ),
  },

  // Sprint 3: Logging & Debug
  {
    path: 'logs',
    loadComponent: () =>
      import('./features/logs/logs-page.component').then(
        (m) => m.LogsPageComponent
      ),
  },

  // Sprint 3: Observations & Reflections
  {
    path: 'observations',
    loadComponent: () =>
      import('./features/observations/observations-page.component').then(
        (m) => m.ObservationsPageComponent
      ),
  },

  // Sprint 3: Plugins
  {
    path: 'plugins',
    loadComponent: () =>
      import('./features/plugins/plugins-page.component').then(
        (m) => m.PluginsPageComponent
      ),
  },

  // Sprint 3: Model Management
  {
    path: 'models',
    loadComponent: () =>
      import('./features/models/models-page.component').then(
        (m) => m.ModelsPageComponent
      ),
  },

  // Sprint 3: Remote Config
  {
    path: 'remote-config',
    loadComponent: () =>
      import('./features/remote-config/remote-config-page.component').then(
        (m) => m.RemoteConfigPageComponent
      ),
  },

  // Sprint 3: Cross-Instance Communication
  {
    path: 'communication',
    loadComponent: () =>
      import('./features/communication/communication-page.component').then(
        (m) => m.CommunicationPageComponent
      ),
  },

  // Sprint 3: Multi-Edit
  {
    path: 'multi-edit',
    loadComponent: () =>
      import('./features/multi-edit/multi-edit-page.component').then(
        (m) => m.MultiEditPageComponent
      ),
  },

  // Sprint 3: Editor Integration
  {
    path: 'editor',
    loadComponent: () =>
      import('./features/editor/editor-page.component').then(
        (m) => m.EditorPageComponent
      ),
  },

  // Sprint 3: Archive Management
  {
    path: 'archive',
    loadComponent: () =>
      import('./features/archive/archive-page.component').then(
        (m) => m.ArchivePageComponent
      ),
  },

  // Sprint 3: Semantic Search
  {
    path: 'semantic-search',
    loadComponent: () =>
      import('./features/semantic-search/semantic-search-page.component').then(
        (m) => m.SemanticSearchPageComponent
      ),
  },

  // Channels (Discord/WhatsApp)
  {
    path: 'channels',
    loadChildren: () =>
      import('./features/channels/channels.routes')
        .then(m => m.CHANNELS_ROUTES),
  },

  // Remote Worker Nodes
  {
    path: 'remote-nodes',
    loadComponent: () =>
      import('./features/remote-nodes/remote-nodes-page.component').then(
        (m) => m.RemoteNodesPageComponent,
      ),
  },

  // Catch-all redirect to dashboard
  {
    path: '**',
    redirectTo: '',
  },
];
