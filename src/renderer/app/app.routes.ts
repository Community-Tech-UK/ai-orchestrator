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
      import('./features/workflow/workflow-progress.component').then(
        (m) => m.WorkflowProgressComponent
      ),
  },

  // Phase 6: Hooks Configuration
  {
    path: 'hooks',
    loadComponent: () =>
      import('./features/hooks/hooks-config.component').then(
        (m) => m.HooksConfigComponent
      ),
  },

  // Phase 6: Skills Browser
  {
    path: 'skills',
    loadComponent: () =>
      import('./features/skills/skill-browser.component').then(
        (m) => m.SkillBrowserComponent
      ),
  },

  // Phase 6: Review Results
  {
    path: 'reviews',
    loadComponent: () =>
      import('./features/review/review-results.component').then(
        (m) => m.ReviewResultsComponent
      ),
  },

  // Phase 7: Specialists Picker
  {
    path: 'specialists',
    loadComponent: () =>
      import('./features/specialists/specialist-picker.component').then(
        (m) => m.SpecialistPickerComponent
      ),
  },

  // Phase 7: Worktree Panel
  {
    path: 'worktrees',
    loadComponent: () =>
      import('./features/worktree/worktree-panel.component').then(
        (m) => m.WorktreePanelComponent
      ),
  },

  // Phase 7: Supervision Tree View
  {
    path: 'supervision',
    loadComponent: () =>
      import('./features/supervision/tree-view.component').then(
        (m) => m.SupervisionTreeViewComponent
      ),
  },

  // Phase 8: RLM Context Browser
  {
    path: 'rlm',
    loadComponent: () =>
      import('./features/rlm/rlm-context-browser.component').then(
        (m) => m.RlmContextBrowserComponent
      ),
  },

  // Phase 8: GRPO Training Dashboard
  {
    path: 'training',
    loadComponent: () =>
      import('./features/training/grpo-dashboard.component').then(
        (m) => m.GrpoDashboardComponent
      ),
  },

  // Phase 9: Memory Browser
  {
    path: 'memory',
    loadComponent: () =>
      import('./features/memory/memory-browser.component').then(
        (m) => m.MemoryBrowserComponent
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
      import('./features/debate/debate-visualization.component').then(
        (m) => m.DebateVisualizationComponent
      ),
  },

  // Catch-all redirect to dashboard
  {
    path: '**',
    redirectTo: '',
  },
];
