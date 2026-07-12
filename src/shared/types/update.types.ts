export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type UpdateErrorContext = 'check' | 'download' | 'install';

/** Renderer-safe snapshot of the desktop application updater. */
export interface UpdateStatus {
  state: UpdateState;
  enabled: boolean;
  currentVersion?: string;
  availableVersion?: string;
  /** Download progress from 0 to 100 while an update is downloading. */
  percent?: number;
  /** ISO timestamp of the most recent attempted update check. */
  lastCheckedAt?: string;
  error?: string;
  errorContext?: UpdateErrorContext;
}
