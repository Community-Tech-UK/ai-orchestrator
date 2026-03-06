export type RepoJobType = 'pr-review' | 'issue-implementation' | 'repo-health-audit';

export type RepoJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface RepoJobDiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface RepoJobRepoContext {
  gitAvailable: boolean;
  isRepo: boolean;
  gitRoot?: string;
  currentBranch?: string;
  defaultRemote?: string;
  changedFiles: string[];
  diffStats?: RepoJobDiffStats;
}

export interface RepoJobWorktreeContext {
  sessionId: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  filesChanged: string[];
  totalAdditions: number;
  totalDeletions: number;
  canAutoMerge?: boolean;
  conflictFiles?: string[];
}

export interface RepoJobSubmission {
  id?: string;
  type: RepoJobType;
  workingDirectory: string;
  issueOrPrUrl?: string;
  title?: string;
  description?: string;
  baseBranch?: string;
  branchRef?: string;
  workflowTemplateId?: string;
  useWorktree?: boolean;
  browserEvidence?: boolean;
}

export interface RepoJobResult {
  instanceId?: string;
  summary?: string;
  repoContext: RepoJobRepoContext;
  worktree?: RepoJobWorktreeContext;
}

export interface RepoJobRecord {
  id: string;
  taskId: string;
  name: string;
  type: RepoJobType;
  status: RepoJobStatus;
  workingDirectory: string;
  issueOrPrUrl?: string;
  title?: string;
  description?: string;
  baseBranch?: string;
  branchRef?: string;
  workflowTemplateId: string;
  useWorktree: boolean;
  progress: number;
  progressMessage?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  repoContext: RepoJobRepoContext;
  instanceId?: string;
  result?: RepoJobResult;
  error?: string;
  submission: RepoJobSubmission;
}

export interface RepoJobListOptions {
  status?: RepoJobStatus;
  type?: RepoJobType;
  limit?: number;
}

export interface RepoJobStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  total: number;
}
