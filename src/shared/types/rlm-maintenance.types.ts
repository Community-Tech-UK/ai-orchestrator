export const RLM_STORAGE_WARNING_BYTES = 10 * 1024 * 1024 * 1024;
export const RLM_STORAGE_HARD_LIMIT_BYTES = 12 * 1024 * 1024 * 1024;
export const RLM_STALE_STORE_RETENTION_DAYS = 60;
export const RLM_STALE_STORE_RETENTION_MS =
  RLM_STALE_STORE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const RLM_BACKUP_RETENTION_COUNT = 2;

export type RlmStorageHealthLevel = 'healthy' | 'warning' | 'critical';
export type RlmMaintenanceStage =
  | 'preparing'
  | 'backing-up'
  | 'pruning'
  | 'compacting'
  | 'reloading'
  | 'complete'
  | 'failed';

export interface RlmMaintenanceRequest {
  loopRunId?: string;
  deleteOldBackups?: string[];
}

export interface RlmStorageHealth {
  level: RlmStorageHealthLevel;
  databaseSizeBytes: number;
  externalContentSizeBytes: number;
  reclaimableDatabaseBytes: number;
  warningThresholdBytes: number;
  hardLimitBytes: number;
  maintenanceRunning: boolean;
  checkedAt: number;
}

export interface RlmMaintenancePreview {
  databaseSizeBytes: number;
  externalContentSizeBytes: number;
  reclaimableDatabaseBytes: number;
  eligibleStoreCount: number;
  protectedLiveStoreCount: number;
  protectedCodebaseAutoStoreCount: number;
  cutoffTimestamp: number;
  retentionDays: number;
  backupDirectory: string;
  backups: { name: string; createdAt: number; bytes: number; wouldBeRemoved: boolean }[];
  canRun: boolean;
  generatedAt: number;
}

export interface RlmMaintenanceProgress {
  operationId: string;
  stage: RlmMaintenanceStage;
  message: string;
  startedAt: number;
  updatedAt: number;
}

export interface RlmMaintenanceRunningResult {
  status: 'running';
  operationId: string;
  stage: RlmMaintenanceStage;
  startedAt: number;
}

export interface RlmMaintenanceSuccessResult {
  status: 'success';
  operationId: string;
  storesDeleted: number;
  databaseSizeBeforeBytes: number;
  databaseSizeAfterBytes: number;
  externalContentSizeBeforeBytes: number;
  externalContentSizeAfterBytes: number;
  verifiedBytesReclaimed: number;
  backupPath: string;
  backupsPruned?: number;
  backupsKept?: number;
  backupBytesFreed?: number;
  externalContentCleanupFailures: number;
  loopResumed: boolean;
  databaseHealthy: boolean;
  completedAt: number;
}

export interface RlmMaintenanceFailureResult {
  status: 'failed';
  operationId: string;
  failedStage: Exclude<RlmMaintenanceStage, 'complete' | 'failed'>;
  error: string;
  backupPath?: string;
  storesDeleted: number;
  externalContentCleanupFailures: number;
  completedAt: number;
}

export type RlmMaintenanceResult =
  | RlmMaintenanceRunningResult
  | RlmMaintenanceSuccessResult
  | RlmMaintenanceFailureResult;
