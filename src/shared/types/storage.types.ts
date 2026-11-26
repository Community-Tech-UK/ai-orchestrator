export type StorageCleanupTarget =
  | 'event-record'
  | 'event-record-shrink'
  | 'rlm-backups'
  | 'session-records'
  | 'activity-logs'
  | 'legacy-app-data'
  | 'claude-attachments'
  | 'codex-state-backups'
  | 'rtk-history';
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
export interface StorageCleanupItem {
  name: string;
  bytes: number;
  createdAt: number;
  /** Session copies this item covers (pasted-attachments folders). */
  sessions?: number;
  /** Optional sub-group label (for example Codex copy kinds). */
  group?: string;
}
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
export interface StorageCleanupResult {
  target: StorageCleanupTarget;
  removed: number;
  /** Physical disk bytes returned to the OS, not an estimate of reusable database pages. */
  bytesFreed: number;
  /** RTK only: a bounded trim stopped with older rows possibly remaining. */
  stoppedEarly?: boolean;
}

/** Counts and bytes confirmed by a cleanup executor after file removal. */
export type StorageRemovalReceipt = Pick<StorageCleanupResult, 'removed' | 'bytesFreed'>;
