/**
 * Worktree Types - Git worktree management for parallel agent development
 * Based on validated patterns from CodeRabbit git-worktree-runner, Nx, incident.io
 */

export type WorktreeStatus =
  | 'creating' // Being set up
  | 'installing' // Running npm install
  | 'active' // In use by subagent
  | 'completed' // Work done, pending merge
  | 'merging' // Merge in progress
  | 'merged' // Successfully merged
  | 'conflict' // Merge conflicts detected
  | 'abandoned'; // User chose not to merge

export type MergeStrategy =
  | 'auto' // Attempt auto-merge
  | 'manual' // Always require manual resolution
  | 'rebase' // Rebase instead of merge
  | 'squash'; // Squash commits on merge

export interface WorktreeConfig {
  baseDir: string; // Where to create worktrees (default: .worktrees)
  prefix: string; // Naming prefix (default: task-)
  autoCleanup: boolean; // Remove after merge (default: true)
  defaultStrategy: MergeStrategy;

  // Config file copying (validated from CodeRabbit pattern)
  copyInclude: string[]; // Glob patterns to copy (e.g., '.env*', 'docker-compose*.yml')
  copyExclude: string[]; // Glob patterns to exclude (e.g., 'node_modules/**')

  // Dependency management
  installDeps: boolean; // Run npm install in new worktree
  installCommand?: string; // Custom install command (default: npm install --prefer-offline)

  // Limits
  maxConcurrent: number; // Max simultaneous worktrees (recommended: 3-5)
  maxAgeHours: number; // Auto-cleanup abandoned worktrees after N hours
}

export interface WorktreeSession {
  id: string;
  instanceId: string; // Parent orchestrator instance
  childInstanceId?: string; // Subagent instance using this worktree

  // Git info
  worktreePath: string;
  branchName: string;
  baseBranch: string; // Branch we diverged from
  baseCommit: string; // Commit when worktree was created

  // Status
  status: WorktreeStatus;
  lastActivity: number;
  healthCheck?: WorktreeHealthCheck;

  // Changes tracking
  commits: WorktreeCommit[];
  filesChanged: string[];
  additions: number;
  deletions: number;

  // Timing
  createdAt: number;
  completedAt?: number;
  mergedAt?: number;

  // Task context
  taskDescription: string;
  taskType: 'feature' | 'bugfix' | 'refactor' | 'docs' | 'test';

  // P7: per-session renderer port (runtime namespacing) so parallel
  // renderer/smoke sessions don't collide on the shared AIO_RENDERER_PORT.
  rendererPort?: number;
}

export interface WorktreeHealthCheck {
  lastCheck: number;
  isHealthy: boolean;
  issues: string[];
  agentResponsive: boolean;
  diskUsageMB: number;
}

export interface WorktreeCommit {
  hash: string;
  message: string;
  author: string;
  timestamp: number;
  filesChanged: string[];
}

export interface WorktreeMergePreview {
  worktreeId: string;
  targetBranch: string;
  strategy: MergeStrategy;

  // Conflict analysis
  canAutoMerge: boolean;
  conflictFiles: string[];
  conflictDetails: ConflictDetail[];

  // Change summary
  commits: WorktreeCommit[];
  totalAdditions: number;
  totalDeletions: number;
  filesChanged: string[];

  // Cross-worktree conflicts (CRITICAL for parallel agents)
  crossConflicts?: CrossWorktreeConflict[];

  // Merge preview diff
  previewDiff?: string;
}

export interface ConflictDetail {
  file: string;
  ourChanges: string; // Changes in worktree
  theirChanges: string; // Changes in target branch
  baseContent: string; // Common ancestor content
  conflictType: 'content' | 'rename' | 'delete' | 'add' | 'mode';
  suggestedResolution?: string; // AI-suggested resolution
}

export interface CrossWorktreeConflict {
  file: string;
  worktrees: string[]; // IDs of conflicting worktrees
  description: string;
  severity: 'high' | 'medium' | 'low';
  mergeOrder?: string[]; // Suggested merge order to minimize conflicts
}

export interface WorktreeMergeResult {
  success: boolean;
  worktreeId: string;
  mergeCommit?: string;
  error?: string;
  resolvedConflicts?: string[];
  manualResolutionRequired?: string[];
  /**
   * P4: when the merge ran in a dedicated integration worktree (opt-in), the
   * isolated branch that now holds the integrated result. The orchestrator
   * fast-forwards the real target from here; the root checkout is never touched.
   */
  integrationBranch?: string;
}

// Events
export type WorktreeEventType =
  | 'worktree:creating'
  | 'worktree:installing'
  | 'worktree:created'
  | 'worktree:completed'
  | 'worktree:merging'
  | 'worktree:merged'
  | 'worktree:conflict'
  | 'worktree:abandoned'
  | 'worktree:cleaned'
  | 'worktree:stale'
  | 'worktree:error'
  | 'worktree:sync-available';

export interface WorktreeEvent {
  type: WorktreeEventType;
  session: WorktreeSession;
  error?: string;
  behind?: number; // For sync-available
}

// Helper functions
export function createDefaultWorktreeConfig(): WorktreeConfig {
  return {
    baseDir: '.worktrees',
    prefix: 'task-',
    autoCleanup: true,
    defaultStrategy: 'auto',
    copyInclude: ['.env.local', '.env.development.local', '.env.*.local', 'docker-compose.override.yml'],
    copyExclude: ['node_modules/**', '.git/**', 'dist/**', 'build/**', 'coverage/**'],
    installDeps: true,
    installCommand: 'npm install --prefer-offline',
    maxConcurrent: 5,
    maxAgeHours: 48,
  };
}

export function sanitizeBranchName(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 30)
    .replace(/-+$/, '');
}

export function isWorktreeActive(session: WorktreeSession): boolean {
  return ['creating', 'installing', 'active'].includes(session.status);
}

export function isWorktreeMergeable(session: WorktreeSession): boolean {
  return session.status === 'completed';
}
