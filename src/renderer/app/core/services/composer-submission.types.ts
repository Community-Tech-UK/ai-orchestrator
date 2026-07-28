/**
 * Durable journal of new-session composer submissions.
 *
 * A record is written *before* the composition leaves the composer and is
 * deleted only once the main process returns an instance id. Anything left
 * behind is unsent work that must be given back to the user.
 */

export type ComposerSubmissionStatus =
  /** Written at submit time; an acknowledgement is outstanding. */
  | 'pending'
  /** The attempt failed, or the app restarted while it was pending. */
  | 'failed';

export interface ComposerSubmissionInput {
  /** `NewSessionDraftService` key the composition belongs to. */
  draftKey: string;
  workingDirectory: string | null;
  text: string;
  pendingFolders: string[];
  files: File[];
}

export type ComposerSubmissionStage =
  | 'begin'
  | 'retry'
  | 'amended'
  | 'accepted'
  | 'failed'
  | 'discarded'
  | 'orphaned';

export interface ComposerSubmissionStageEvent {
  stage: ComposerSubmissionStage;
  at: number;
  detail?: string;
}

export interface ComposerSubmissionRecord extends ComposerSubmissionInput {
  /** Correlation id. Doubles as the create-with-message idempotency key. */
  id: string;
  status: ComposerSubmissionStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError: string | null;
  /**
   * Stage trail for this submission, keyed by the same correlation id the main
   * process logs. Kept on the record rather than in `console` so it survives a
   * reload and can be read back when diagnosing a loss.
   */
  stages: ComposerSubmissionStageEvent[];
}

/**
 * Storage backend for the journal.
 *
 * Implemented over IndexedDB in the app, because it is the only browser store
 * that persists `File`/`Blob` values — `localStorage` (which backs the draft
 * store) can only hold the text, which is precisely how the attachments were
 * lost. A memory implementation stands in when IndexedDB is unavailable.
 */
export interface ComposerSubmissionStorage {
  list(): Promise<ComposerSubmissionRecord[]>;
  put(record: ComposerSubmissionRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

export const COMPOSER_SUBMISSION_DB_NAME = 'harness-composer-submissions';
export const COMPOSER_SUBMISSION_STORE_NAME = 'submissions';
export const COMPOSER_SUBMISSION_DB_VERSION = 1;

/**
 * How long to wait for an acknowledgement before failing the submission closed.
 * Long enough to cover a badly blocked main event loop (the incident window
 * showed `rlm-storage:get-health` blocking for ~2.4s at a time), short enough
 * that the composer never hangs indefinitely.
 */
export const COMPOSER_SUBMISSION_ACK_TIMEOUT_MS = 60_000;

/**
 * Retention for unsent compositions.
 *
 * Records hold full image blobs, and one whose draft key the user never
 * revisits is never surfaced, so the journal needs a ceiling or it grows
 * without bound. Both limits are generous — an unsent prompt stays available
 * for a month, and only the oldest are dropped past the count cap.
 */
export const COMPOSER_SUBMISSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
export const COMPOSER_SUBMISSION_MAX_RECORDS = 20;
