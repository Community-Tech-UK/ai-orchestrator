export type OperatorProjectSource =
  | 'recent-directory'
  | 'active-instance'
  | 'conversation-ledger'
  | 'scan'
  | 'manual';

export interface OperatorProjectRemote {
  name: string;
  url: string;
}

export interface OperatorProjectRecord {
  id: string;
  canonicalPath: string;
  displayName: string;
  aliases: string[];
  source: OperatorProjectSource;
  gitRoot: string | null;
  remotes: OperatorProjectRemote[];
  currentBranch: string | null;
  isPinned: boolean;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  metadata: Record<string, unknown>;
}

export interface OperatorProjectUpsertInput {
  canonicalPath: string;
  displayName: string;
  aliases?: string[];
  source: OperatorProjectSource;
  gitRoot?: string | null;
  remotes?: OperatorProjectRemote[];
  currentBranch?: string | null;
  isPinned?: boolean;
  lastSeenAt?: number;
  lastAccessedAt?: number | null;
  metadata?: Record<string, unknown>;
}

export interface OperatorProjectListQuery {
  query?: string;
  limit?: number;
}

export type OperatorProjectResolutionStatus = 'resolved' | 'ambiguous' | 'not_found';

export interface OperatorProjectResolution {
  status: OperatorProjectResolutionStatus;
  query: string;
  project: OperatorProjectRecord | null;
  candidates: OperatorProjectRecord[];
}

export interface OperatorProjectRefreshOptions {
  roots?: string[];
  includeRecent?: boolean;
  includeActiveInstances?: boolean;
  includeConversationLedger?: boolean;
}

export type OperatorGitBatchRepoStatus = 'pulled' | 'up_to_date' | 'skipped' | 'failed';

export type OperatorGitBatchSkipReason =
  | 'no_remote'
  | 'no_upstream'
  | 'dirty_worktree'
  | 'divergent'
  | 'detached_head';

export interface OperatorGitBatchRepoResult {
  repositoryPath: string;
  status: OperatorGitBatchRepoStatus;
  reason: OperatorGitBatchSkipReason | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  durationMs: number;
  error: string | null;
}

export interface OperatorGitBatchSummary {
  rootPath: string;
  total: number;
  pulled: number;
  upToDate: number;
  skipped: number;
  failed: number;
  results: OperatorGitBatchRepoResult[];
}

export type OperatorRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type OperatorNodeType =
  | 'plan'
  | 'discover-projects'
  | 'project-agent'
  | 'repo-job'
  | 'workflow'
  | 'git-batch'
  | 'shell'
  | 'verification'
  | 'synthesis';

export type OperatorRunEventKind =
  | 'state-change'
  | 'progress'
  | 'shell-command'
  | 'fs-write'
  | 'instance-spawn'
  | 'verification-result'
  | 'recovery'
  | 'budget';

export interface OperatorRunBudget {
  maxNodes: number;
  maxRetries: number;
  maxWallClockMs: number;
  maxTokens?: number;
  maxConcurrentNodes: number;
}

export type OperatorVerificationProjectKind =
  | 'node'
  | 'typescript'
  | 'rust'
  | 'maven'
  | 'go'
  | 'python'
  | 'unknown';

export type OperatorVerificationCheckStatus = 'passed' | 'failed' | 'skipped';

export interface OperatorVerificationCheckResult {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  status: OperatorVerificationCheckStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  error: string | null;
}

export interface OperatorVerificationSummary {
  status: 'passed' | 'failed' | 'skipped';
  projectPath: string;
  kinds: OperatorVerificationProjectKind[];
  requiredFailed: number;
  optionalFailed: number;
  checks: OperatorVerificationCheckResult[];
  fallbackReason?: string;
}

export type OperatorVerificationResultEventPayload =
  Record<string, unknown> & OperatorVerificationSummary;

export interface OperatorRunUsage {
  nodesStarted: number;
  nodesCompleted: number;
  retriesUsed: number;
  tokensUsed?: number;
  wallClockMs: number;
}

export type OperatorShellCommandEventPayload = Record<string, unknown> & {
  cmd: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut?: boolean;
  error?: string;
};

export type OperatorFsWriteEventPayload = Record<string, unknown> & {
  path: string;
  bytesWritten: number;
  sha256: string;
  kind: 'create' | 'modify' | 'delete';
};

export interface OperatorRunRecord {
  id: string;
  threadId: string;
  sourceMessageId: string;
  title: string;
  status: OperatorRunStatus;
  autonomyMode: 'full';
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  goal: string;
  budget: OperatorRunBudget;
  usageJson: OperatorRunUsage;
  planJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  error: string | null;
}

export interface OperatorRunNodeRecord {
  id: string;
  runId: string;
  parentNodeId: string | null;
  type: OperatorNodeType;
  status: OperatorRunStatus;
  targetProjectId: string | null;
  targetPath: string | null;
  title: string;
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown> | null;
  externalRefKind: 'instance' | 'repo-job' | 'workflow' | 'task' | 'worktree' | null;
  externalRefId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
}

export interface OperatorRunEventRecord {
  id: string;
  runId: string;
  nodeId: string | null;
  kind: OperatorRunEventKind;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface OperatorRunEventNotification {
  runId: string;
  nodeId: string | null;
  event: OperatorRunEventRecord;
}

export type OperatorInstanceLinkRecoveryState = 'active' | 'recovered' | 'stale';

export interface OperatorInstanceLinkRecord {
  instanceId: string;
  runId: string;
  nodeId: string;
  createdAt: number;
  lastSeenAt: number;
  recoveryState: OperatorInstanceLinkRecoveryState;
}

export interface OperatorRunGraph {
  run: OperatorRunRecord;
  nodes: OperatorRunNodeRecord[];
  events: OperatorRunEventRecord[];
}
