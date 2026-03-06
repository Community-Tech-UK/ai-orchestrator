import type { ResolvedInstructionSource } from './instruction-source.types';

export type TaskPreflightSurface =
  | 'repo-job'
  | 'workflow'
  | 'worktree'
  | 'verification';

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
  filesystem: TaskPreflightFilesystemSummary;
  network: TaskPreflightNetworkSummary;
  mcp: TaskPreflightMcpSummary;
  permissions: TaskPreflightPermissionsSummary;
  blockers: string[];
  warnings: string[];
  recommendedLinks: TaskPreflightLink[];
}
