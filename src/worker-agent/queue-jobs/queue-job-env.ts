import type { QueueProcessRunner } from './queue-process';
import type { KeyedMutex } from './queue-keyed-mutex';
import type { QueueJobPaths } from './queue-job-paths';

/** The three folders one job's session is allowed to use, on top of the worker's normal list. */
export interface QueueJobFolders {
  jobFolder: string;
  planningFolder: string;
  reportFolder: string;
}

/** What the worker's instance manager gives the queue: the per-session allowed folders and the busy check. */
export interface QueueJobFolderControl {
  registerQueueJobFolders(folders: QueueJobFolders): void;
  unregisterQueueJobFolders(jobFolder: string): void;
  /** True while any session of this worker works in (or was given) one of these folders. */
  hasInstanceInFolders(folders: readonly string[]): boolean;
}

export interface QueueWorktreeRequest {
  jobId: string;
  branch: string;
  /** The commit the new branch starts at. */
  commit: string;
  /** The project's installed checkout: the "main checkout" the folder's setup comes from. */
  installedPath: string;
}

/** Makes a job folder on a new branch (with its setup) and returns its path. */
export type QueueWorktreeCreator = (request: QueueWorktreeRequest) => Promise<string>;

/** Installs the project's dependencies in its installed checkout; throws with a plain message on failure. */
export type QueueInstaller = (installedPath: string, hasLockFile: boolean) => Promise<void>;

export interface QueueJobLimits {
  /** The most bytes of pack one upload may hold. */
  maxUploadBytes: number;
  /** An upload untouched this long is abandoned and deleted. */
  uploadMaxAgeMs: number;
  installTimeoutMs: number;
  /** The time limit of each `npm run <script>` in a project check. */
  stepTimeoutMs: number;
  /** The largest planning document that comes back. */
  maxDocumentBytes: number;
  /** The most planning-document bytes one collect returns. */
  maxCollectDocumentBytes: number;
}

export const DEFAULT_QUEUE_JOB_LIMITS: QueueJobLimits = {
  maxUploadBytes: 4 * 1024 * 1024 * 1024,
  uploadMaxAgeMs: 2 * 60 * 60_000,
  installTimeoutMs: 20 * 60_000,
  stepTimeoutMs: 15 * 60_000,
  maxDocumentBytes: 8 * 1024 * 1024,
  maxCollectDocumentBytes: 24 * 1024 * 1024,
};

/** What every queue call shares. */
export interface QueueJobEnv {
  paths: QueueJobPaths;
  runner: QueueProcessRunner;
  install: QueueInstaller;
  createWorktree: QueueWorktreeCreator;
  folders: QueueJobFolderControl;
  mutex: KeyedMutex;
  limits: QueueJobLimits;
  now: () => number;
}
