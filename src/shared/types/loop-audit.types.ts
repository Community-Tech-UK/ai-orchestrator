export type LoopFinalAuditMode = 'off' | 'observe' | 'gate';
export type LoopPreflightMode = 'off' | 'record' | 'block';
export type LoopPlanPacketMode = 'off' | 'prompted';

export interface LoopAuditConfig {
  finalAuditMode: LoopFinalAuditMode;
  preflightMode: LoopPreflightMode;
  planPacketMode: LoopPlanPacketMode;
  cleanlinessScan: boolean;
}

export function defaultLoopAuditConfig(): LoopAuditConfig {
  return {
    finalAuditMode: 'observe',
    preflightMode: 'off',
    planPacketMode: 'off',
    cleanlinessScan: true,
  };
}

export type LoopAuditStatus = 'passed' | 'failed' | 'needs-review' | 'skipped';

export interface LoopAuditFinding {
  severity: 'blocking' | 'review' | 'info';
  code:
    | 'verify-failed'
    | 'ledger-open'
    | 'no-deliverable-change'
    | 'repo-state-unavailable'
    | 'plan-criteria-unproven'
    | 'cleanliness-blocking'
    | 'preflight-red-baseline'
    | 'audit-internal-error';
  message: string;
  file?: string;
  detail?: Record<string, unknown>;
}

export interface LoopFinalAuditResult {
  status: LoopAuditStatus;
  ranAt: number;
  coverage: {
    criteriaTotal: number;
    criteriaVerified: number;
    criteriaUnverified: number;
    verifyCommandRan: boolean;
    repoComparisonRan: boolean;
    cleanlinessScanRan: boolean;
  };
  findings: LoopAuditFinding[];
  changedFiles: string[];
  reportPath?: string;
}

export interface LoopPreflightResult {
  status: 'passed' | 'failed' | 'skipped';
  ranAt: number;
  commands: Array<{
    label: 'quick-verify' | 'verify' | 'extra';
    command: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    outputExcerpt: string;
  }>;
}

export interface LoopRepoBaselineSnapshot {
  source: 'git' | 'none';
  capturedAt: number;
  workspaceCwd: string;
  headRef: string | null;
  dirtyAtStart: boolean;
  trackedDirtyAtStart: string[];
  untrackedAtStart: string[];
  trackedDirtyHashes?: Record<string, string>;
  untrackedHashes?: Record<string, string>;
}

export interface LoopPhaseSpec {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  requiredCommands: string[];
  evidence: string[];
}

export interface LoopPlanPacketSummary {
  roadmapPath: string;
  phases: LoopPhaseSpec[];
  criteriaTotal: number;
  criteriaWithEvidence: number;
  malformed: boolean;
}

export interface LoopPhaseRecoveryState {
  phaseId: string;
  consecutiveFailures: number;
  lastFailureAt: number;
  lastFindingCodes: string[];
}
