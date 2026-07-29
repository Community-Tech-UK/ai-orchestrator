import { computed, signal } from '@angular/core';
import type { ComposerSubmissionService } from '../../core/services/composer-submission.service';
import type { ComposerSubmissionRecord } from '../../core/services/composer-submission.types';
import { COMPOSER_SUBMISSION_ACK_TIMEOUT_MS } from '../../core/services/composer-submission.types';

/**
 * Payload emitted by the new-session composer.
 *
 * The composer keeps its text and attachments until `onResolved` is called, so
 * whoever handles this MUST call it exactly once — on success with the new
 * instance id, on failure with a reason. Failing to call it leaves the
 * composer in its sending state until the acknowledgement timeout fires.
 */
export interface NewSessionSubmitRequest {
  /** Correlation id; also the create-with-message idempotency key. */
  submissionId: string;
  text: string;
  /**
   * Attachments and folder references for THIS submission, taken from the
   * journal rather than read live at handling time. A retry of a composition
   * recovered after a restart has an empty composer, so a handler that read the
   * live draft would silently send a text-only message and then delete the
   * images as "accepted".
   */
  files: File[];
  pendingFolders: string[];
  onResolved: (result: { ok: true; instanceId: string } | { ok: false; error: string }) => void;
  /**
   * Register a callback for "the composer gave up waiting".
   *
   * The handler uses it to drop in-flight UI (the "Starting conversation…"
   * view, which unmounts the composer and would otherwise hide the recovery
   * banner behind a spinner forever). A later `onResolved` is still honoured
   * for journal cleanup.
   */
  onTimeout: (handler: () => void) => void;
}

export interface NewSessionSubmitDeps {
  /** Journals the composition durably. Resolves before anything is emitted. */
  begin: () => Promise<ComposerSubmissionRecord>;
  /** Removes the journal entry and the staged attachments. */
  accept: (submissionId: string, instanceId: string) => Promise<void>;
  /**
   * Accept only if nothing has re-opened the record since. Used for a success
   * that lands after this submission already gave up: a Retry started in the
   * meantime owns the record, and deleting it underneath would leave that retry
   * with nothing to fall back on if it fails.
   */
  acceptIfStillSettled: (submissionId: string, instanceId: string) => Promise<void>;
  /** Keeps the journal entry and marks it recoverable. */
  fail: (submissionId: string, error: string) => Promise<void>;
  emit: (request: NewSessionSubmitRequest) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
  /** Runs only after a confirmed acceptance. */
  clearComposer: () => void;
}

/**
 * Run one new-session submission, keeping the composer populated throughout.
 *
 * This replaces the old `emit(); clearSubmittedMessage();` pair, which cleared
 * the textarea *and* the persisted draft *and* the staged `File` objects the
 * instant the emit call returned — i.e. as soon as the async handler suspended,
 * long before the main process had accepted anything. Every downstream failure
 * therefore destroyed the composition outright.
 *
 * Resolves `true` only when an instance id came back.
 */
export async function submitNewSession(
  deps: NewSessionSubmitDeps,
  ackTimeoutMs: number = COMPOSER_SUBMISSION_ACK_TIMEOUT_MS,
): Promise<boolean> {
  // Set before the (awaited, IndexedDB-backed) journal write: `canSend()` gates
  // on this flag, and the composer is no longer emptied synchronously, so
  // without it a second Enter during the write starts a second submission with
  // a different id — which the main-process idempotency cache cannot dedupe.
  deps.setSubmitting(true);
  deps.setSubmitError(null);

  let record: ComposerSubmissionRecord;
  try {
    record = await deps.begin();
  } catch (error) {
    deps.setSubmitting(false);
    deps.setSubmitError(error instanceof Error ? error.message : String(error));
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const settle = (result: { ok: true; instanceId: string } | { ok: false; error: string }) => {
      if (settled) {
        // A late success still means the session exists, so the journal entry
        // is no longer unsent and must go — otherwise the user is shown a
        // permanent "not sent" banner for a session that was created. The
        // composer is NOT cleared: the user may have refilled it since.
        if (result.ok) {
          void deps.acceptIfStillSettled(record.id, result.instanceId);
        }
        return;
      }
      settled = true;
      if (timeout) clearTimeout(timeout);
      deps.setSubmitting(false);

      if (result.ok) {
        void deps.accept(record.id, result.instanceId);
        deps.clearComposer();
        resolve(true);
        return;
      }

      deps.setSubmitError(result.error);
      void deps.fail(record.id, result.error);
      resolve(false);
    };

    let onTimeoutHandler: (() => void) | null = null;
    const request: NewSessionSubmitRequest = {
      submissionId: record.id,
      text: record.text,
      files: record.files,
      pendingFolders: record.pendingFolders,
      onResolved: settle,
      onTimeout: (handler) => {
        onTimeoutHandler = handler;
      },
    };

    timeout = setTimeout(() => {
      onTimeoutHandler?.();
      settle({
        ok: false,
        error:
          'The session was not confirmed within 60 seconds. Nothing was sent — your message and ' +
          'attachments are still here. Retry, or check the app logs.',
      });
    }, ackTimeoutMs);

    try {
      deps.emit(request);
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

export interface NewSessionRetryDeps {
  isSubmitting: () => boolean;
  /** Re-opens the journal entry under the same correlation id. */
  retry: (submissionId: string) => Promise<ComposerSubmissionRecord | null>;
  /** Live composer content, used when the user edited it after the failure. */
  currentText: () => string;
  currentFiles: () => File[];
  currentFolders: () => string[];
  /** Rewrites the journalled content before the retry is emitted. */
  amend: (
    submissionId: string,
    content: { text: string; files: File[]; pendingFolders: string[] },
  ) => Promise<ComposerSubmissionRecord | null>;
  accept: (submissionId: string, instanceId: string) => Promise<void>;
  acceptIfStillSettled: (submissionId: string, instanceId: string) => Promise<void>;
  fail: (submissionId: string, error: string) => Promise<void>;
  emit: (request: NewSessionSubmitRequest) => void;
  setSubmitting: (value: boolean) => void;
  setSubmitError: (value: string | null) => void;
  clearComposer: () => void;
}

/**
 * Re-send a composition recovered from the journal.
 *
 * Reuses the original submission id, so if the first attempt actually reached
 * the main process and only the acknowledgement was lost, the retry is
 * recognised as a duplicate and returns that same session instead of starting
 * a second one.
 */
export async function retryNewSession(
  deps: NewSessionRetryDeps,
  record: ComposerSubmissionRecord,
  ackTimeoutMs: number = COMPOSER_SUBMISSION_ACK_TIMEOUT_MS,
): Promise<boolean> {
  if (deps.isSubmitting()) return false;
  // Claimed before the two awaits below, for the same reason `submitNewSession`
  // claims it before its journal write: a second Retry click in that window
  // would otherwise start an overlapping submission on the same record.
  deps.setSubmitting(true);

  let retried: ComposerSubmissionRecord | null;
  let amended: ComposerSubmissionRecord | null;
  try {
    retried = await deps.retry(record.id);
    if (!retried) {
      deps.setSubmitting(false);
      return false;
    }

    // Each field falls back independently. The two stores do not survive a
    // restart together: the draft *prompt* is persisted to localStorage, the
    // staged `File[]` is in-memory only. So after a restart the composer has
    // text and no attachments — an all-or-nothing rule would amend the record's
    // images away and send a text-only message, losing exactly what this fix
    // exists to protect. Live content wins per field so a post-failure edit is
    // honoured without discarding anything the composer no longer holds.
    const liveText = deps.currentText().trim();
    const liveFiles = deps.currentFiles();
    const liveFolders = deps.currentFolders();
    const content = {
      text: liveText.length > 0 ? liveText : retried.text,
      files: liveFiles.length > 0 ? [...liveFiles] : retried.files,
      pendingFolders: liveFolders.length > 0 ? [...liveFolders] : retried.pendingFolders,
    };
    // Identity, not just length: swapping one attachment for another (remove A,
    // add B) leaves the count unchanged, and skipping the amend there would
    // re-send A and then clear B out of the composer on success.
    const changed =
      content.text !== retried.text
      || content.files.length !== retried.files.length
      || content.files.some((file, index) => file !== retried!.files[index])
      || content.pendingFolders.length !== retried.pendingFolders.length
      || content.pendingFolders.some((folder, index) => folder !== retried!.pendingFolders[index]);
    amended = changed ? await deps.amend(retried.id, content) : retried;
  } catch (error) {
    // Nothing here can reject with the real journal (its writes swallow storage
    // errors), but the flag must not stick if that ever changes.
    deps.setSubmitting(false);
    deps.setSubmitError(error instanceof Error ? error.message : String(error));
    return false;
  }

  return submitNewSession(
    {
      begin: async () => amended ?? retried,
      accept: deps.accept,
      acceptIfStillSettled: deps.acceptIfStillSettled,
      fail: deps.fail,
      emit: deps.emit,
      setSubmitting: deps.setSubmitting,
      setSubmitError: deps.setSubmitError,
      clearComposer: deps.clearComposer,
    },
    ackTimeoutMs,
  );
}

export interface NewSessionSubmissionHost {
  submissions: ComposerSubmissionService;
  /** The `NewSessionDraftService` key the composer is currently editing. */
  draftKey: () => string;
  workingDirectory: () => string | null;
  pendingFolders: () => string[];
  pendingFiles: () => File[];
  /** Live composer text, so a retry picks up edits made after the failure. */
  currentText: () => string;
  isDraftComposer: () => boolean;
  emit: (request: NewSessionSubmitRequest) => void;
  /** Runs only after a confirmed acceptance. */
  clearComposer: () => void;
}

/**
 * New-session submission state for the composer.
 *
 * Bundled into a controller so the component holds one field instead of the
 * signals, computed and three methods this needs — and so the
 * keep-until-acknowledged rule lives next to the journal it depends on.
 */
export class NewSessionSubmissionController {
  /** True while a submission is awaiting acknowledgement. */
  readonly submitting = signal(false);
  /** Reason the last submission failed; shown above the composer. */
  readonly error = signal<string | null>(null);

  /**
   * Unsent composition for this draft, recovered from the durable journal.
   * Present after a failed submission, or after a reload/restart interrupted
   * one. Drives the recovery banner's retry/discard controls.
   */
  readonly recoverable = computed<ComposerSubmissionRecord | null>(() =>
    this.host.isDraftComposer()
      ? this.host.submissions.recoverableFor(this.host.draftKey())
      : null,
  );

  constructor(private readonly host: NewSessionSubmissionHost) {}

  submit(text: string): Promise<boolean> {
    return submitNewSession({
      ...this.deps(),
      begin: () =>
        this.host.submissions.begin({
          draftKey: this.host.draftKey(),
          workingDirectory: this.host.workingDirectory(),
          text,
          pendingFolders: [...this.host.pendingFolders()],
          files: [...this.host.pendingFiles()],
        }),
    });
  }

  retry(record: ComposerSubmissionRecord): Promise<boolean> {
    return retryNewSession(this.deps(), record);
  }

  discard(record: ComposerSubmissionRecord): void {
    this.error.set(null);
    void this.host.submissions.discard(record.id);
  }

  private deps(): NewSessionRetryDeps {
    const { submissions } = this.host;
    return {
      isSubmitting: () => this.submitting(),
      retry: (id) => submissions.retry(id),
      acceptIfStillSettled: (id, instanceId) => submissions.acceptIfStillSettled(id, instanceId),
      currentText: () => this.host.currentText(),
      currentFiles: () => this.host.pendingFiles(),
      currentFolders: () => this.host.pendingFolders(),
      amend: (id, content) => submissions.amend(id, content),
      accept: (id, instanceId) => submissions.markAccepted(id, instanceId),
      fail: async (id, error) => {
        await submissions.markFailed(id, error);
      },
      emit: (request) => this.host.emit(request),
      setSubmitting: (value) => this.submitting.set(value),
      setSubmitError: (value) => this.error.set(value),
      clearComposer: () => this.host.clearComposer(),
    };
  }
}
