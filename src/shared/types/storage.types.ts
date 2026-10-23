export type StorageCleanupTarget = 'event-record' | 'event-record-shrink' | 'rlm-backups' | 'session-records' | 'activity-logs';
export interface StorageUsageRow {
  id: string;
  label: string;
  bytes: number;
  reclaimableBytes: number;
  target?: StorageCleanupTarget;
  shrinkAvailable?: boolean;
  diskReclaimableBytes?: number;
  note: string;
}
export interface StorageCleanupProgress {
  target: StorageCleanupTarget;
  removed: number;
  estimatedTotal: number;
  running: boolean;
}
export interface StorageUsage {
  measuredAt: number;
  totalBytes?: number;
  weeklyGrowthBytes?: number | null;
  rows: StorageUsageRow[];
  reclaimableBytes: number;
  progress: StorageCleanupProgress | null;
}
export interface StorageCleanupItem { name: string; bytes: number; createdAt: number }
export interface StorageCleanupPreview {
  previewId: string;
  target: StorageCleanupTarget;
  items: StorageCleanupItem[];
  bytes: number;
  estimatedCount: number;
  oldestAt: number | null;
  newestAt: number | null;
  consequence: string;
  reversible: false;
  keptBackup?: StorageCleanupItem;
  requiredDiskBytes?: number;
  availableDiskBytes?: number;
  liveBytes?: number;
}
export interface StorageCleanupResult { target: StorageCleanupTarget; removed: number; bytesFreed: number }
