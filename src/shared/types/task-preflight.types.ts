import type { ResolvedInstructionSource } from './instruction-source.types';

export type TaskPreflightSurface =
  | 'repo-job'
  | 'workflow'
  | 'worktree'
  | 'verification'
  | 'automation';

export type TaskPreflightPermissionPreset = 'allow' | 'ask' | 'deny';

export interface TaskPreflightRequest {
  workingDirectory: string;
  surface: TaskPreflightSurface;
  taskType?: string;
  requiresWrite?: boolean;
  requiresNetwork?: boolean;
  requiresBrowser?: boolean;
}

export interface TaskPreflightPrediction {
  label: string;
  certainty: 'expected' | 'likely' | 'possible';
  reason: string;
}

export interface TaskPreflightLink {
  label: string;
  route: string;
}

export interface TaskPreflightInstructionSummary {
  projectRoot: string;
  appliedLabels: string[];
  warnings: string[];
  sources: ResolvedInstructionSource[];
}

export type TaskPreflightBranchPolicyAction = 'allow' | 'warn' | 'block';
export type TaskPreflightBranchRemediation = 'none' | 'set-upstream' | 'merge-forward' | 'rebase';

export interface TaskPreflightBranchPolicy {
  state: 'fresh' | 'stale' | 'diverged' | 'no_upstream' | 'not_repo';
  action: TaskPreflightBranchPolicyAction;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  summary: string;
  recommendedRemediation: TaskPreflightBranchRemediation;
  requiresManualResolution: boolean;
  failureCategory?: 'stale_branch';
}

export interface TaskPreflightFilesystemSummary {
  workingDirectory: string;
  canReadWorkingDirectory: boolean;
  canWriteWorkingDirectory: boolean;
  readPathCount: number;
  writePathCount: number;
  blockedPathCount: number;
  allowTempDir: boolean;
  notes: string[];
}

export interface TaskPreflightNetworkSummary {
  allowAllTraffic: boolean;
  allowedDomainCount: number;
  blockedDomainCount: number;
  sampleAllowedDomains: string[];
  notes: string[];
}

export interface TaskPreflightMcpSummary {
  configuredCount: number;
  connectedCount: number;
  browserStatus: 'ready' | 'partial' | 'missing';
  browserWarnings: string[];
  browserToolNames: string[];
  connectedServerNames: string[];
}

export interface TaskPreflightPermissionsSummary {
  preset: TaskPreflightPermissionPreset;
  defaultAction: TaskPreflightPermissionPreset;
  predictions: TaskPreflightPrediction[];
}

export interface TaskPreflightReport {
  generatedAt: number;
  workingDirectory: string;
  surface: TaskPreflightSurface;
  taskType?: string;
  instructionSummary: TaskPreflightInstructionSummary;
  branchPolicy: TaskPreflightBranchPolicy;
  filesystem: TaskPreflightFilesystemSummary;
  network: TaskPreflightNetworkSummary;
  mcp: TaskPreflightMcpSummary;
  permissions: TaskPreflightPermissionsSummary;
  blockers: string[];
  warnings: string[];
  recommendedLinks: TaskPreflightLink[];
}

export interface AutomationPreflightRequest {
  workingDirectory: string;
  prompt: string;
  provider?: string;
  model?: string;
  yoloMode?: boolean;
  expectedUnattended?: boolean;
}

export interface SuggestedPermissionRule {
  id: string;
  scope: 'session' | 'project' | 'user';
  permission: string;
  pattern: string;
  action: 'allow' | 'ask';
  reason: string;
  risk: 'low' | 'medium' | 'high';
  writeTarget?: {
    filePath: string;
    mode: 'append-rule' | 'update-rule';
  };
  previewRule: {
    permission: string;
    pattern: string;
    action: 'allow' | 'ask';
  };
}

export interface AutomationPromptEditSuggestion {
  id: string;
  reason: string;
  replacementPrompt: string;
}

export interface AutomationPreflightReport extends TaskPreflightReport {
  surface: 'automation';
  okToSave: boolean;
  suggestedPermissionRules: SuggestedPermissionRule[];
  suggestedPromptEdits: AutomationPromptEditSuggestion[];
}

export interface AutomationTemplateSchedule {
  type: 'cron';
  expression: string;
  timezone: string;
}

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  suggestedSchedule: AutomationTemplateSchedule;
  tags: string[];
}
