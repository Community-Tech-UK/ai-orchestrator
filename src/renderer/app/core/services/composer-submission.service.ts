import { Injectable, computed, signal } from '@angular/core';
import { createComposerSubmissionStorage } from './composer-submission-store';
import {
  COMPOSER_SUBMISSION_MAX_AGE_MS,
  COMPOSER_SUBMISSION_MAX_RECORDS,
} from './composer-submission.types';
import type {
  ComposerSubmissionInput,
  ComposerSubmissionRecord,
  ComposerSubmissionStage,
  ComposerSubmissionStageEvent,
  ComposerSubmissionStorage,
} from './composer-submission.types';

/** Bounded so a repeatedly retried submission cannot grow without limit. */
const MAX_STAGE_EVENTS = 50;

function withStage(
  record: ComposerSubmissionRecord,
  stage: ComposerSubmissionStage,
  detail?: string,
): ComposerSubmissionStageEvent[] {
  const event: ComposerSubmissionStageEvent = { stage, at: Date.now(), ...(detail ? { detail } : {}) };
  // `stages` is absent on entries written by an earlier build of the journal.
  return [...(record.stages ?? []), event].slice(-MAX_STAGE_EVENTS);
}

const APP_CLOSED_WHILE_PENDING =
  'The app closed before this message was confirmed. It was never sent — retry or discard it.';

function createSubmissionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Owns unsent new-session compositions.
 *
 * The composer used to be the only holder of the prompt and the staged `File`
 * objects, and it cleared both synchronously the moment Send was pressed —
 * before the main process had accepted anything. Any failure downstream
 * therefore destroyed the composition outright. This service is the durable
 * record that makes that impossible: it is written first, and removed only
 * against a real instance id.
 */
@Injectable({ providedIn: 'root' })
export class ComposerSubmissionService {
  private readonly records = signal<ComposerSubmissionRecord[]>([]);
  // Constructed inline rather than injected: an interface-typed constructor
  // parameter has no runtime value for Angular's JIT reflection to resolve.
  private storage: ComposerSubmissionStorage = createComposerSubmissionStorage();
  private restorePromise: Promise<void> | null = null;
  /**
   * Ids recovered from a previous run. The composer is empty for these, so the
   * journal is their only copy and a new submission must never supersede them.
   */
  private readonly restoredIds = new Set<string>();

  /** Submissions awaiting an acknowledgement. */
  readonly pending = computed(() => this.records().filter((record) => record.status === 'pending'));

  /** Unsent compositions the user can retry or discard. */
  readonly recoverable = computed(() => this.records().filter((record) => record.status === 'failed'));

  /** Swap the backing store and reset in-memory state. Tests only. */
  _setStorageForTesting(storage: ComposerSubmissionStorage): void {
    this.storage = storage;
    this.restorePromise = null;
    this.records.set([]);
    this.restoredIds.clear();
  }

  /**
   * Newest unsent composition for a draft key, if any.
   *
   * Two submissions a few hundred microseconds apart share a millisecond, so
   * `updatedAt` alone is not a total order. Insertion order is the tie-break —
   * `records` preserves it, and after a reload `createdAt` separates them.
   */
  recoverableFor(draftKey: string): ComposerSubmissionRecord | null {
    const candidates = this.recoverable()
      .map((record, index) => ({ record, index }))
      .filter((entry) => entry.record.draftKey === draftKey);

    if (candidates.length === 0) {
      return null;
    }

    return candidates.sort((a, b) =>
      b.record.updatedAt - a.record.updatedAt
      || b.record.createdAt - a.record.createdAt
      || b.index - a.index,
    )[0].record;
  }

  /**
   * Load the journal. Anything still `pending` belonged to a renderer that went
   * away mid-flight, so it was never confirmed and must be offered back.
   *
   * Idempotent — concurrent callers share one pass.
   */
  restore(): Promise<void> {
    if (!this.restorePromise) {
      this.restorePromise = this.runRestore().catch((error) => {
        console.warn('[composer-submission] restore failed', error);
      });
    }

    return this.restorePromise;
  }

  /**
   * Persist a composition before it leaves the composer.
   *
   * Resolves only once the record is durable. Callers must not clear the
   * composer or submit until it does. A failed durable write is logged and
   * swallowed: the in-memory record still drives retry for this session, and an
   * un-journalled send is no worse than the pre-fix behaviour.
   */
  async begin(input: ComposerSubmissionInput): Promise<ComposerSubmissionRecord> {
    const now = Date.now();
    const record: ComposerSubmissionRecord = {
      ...input,
      id: createSubmissionId(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
      attempts: 1,
      lastError: null,
      stages: [{ stage: 'begin', at: now, detail: `${input.text.length} chars, ${input.files.length} files` }],
    };

    // A fresh Send for this draft supersedes any earlier unsent attempt on it.
    // The composer was never cleared, so the new record already contains that
    // content (possibly edited) — leaving the old one would show a recovery
    // banner whose Retry re-sends stale text.
    await this.dropRecoverableFor(input.draftKey);

    await this.write(record);
    this.records.update((current) => [...current, record]);
    return record;
  }

  private async dropRecoverableFor(draftKey: string): Promise<void> {
    const superseded = this.recoverable().filter(
      (entry) => entry.draftKey === draftKey && !this.restoredIds.has(entry.id),
    );
    for (const entry of superseded) {
      await this.remove(entry.id);
    }
  }

  /**
   * Replace a record's content before a retry re-sends it, keeping the
   * correlation id so the main process can still recognise a duplicate.
   */
  async amend(
    id: string,
    content: { text: string; files: File[]; pendingFolders: string[] },
  ): Promise<ComposerSubmissionRecord | null> {
    const record = this.records().find((candidate) => candidate.id === id);
    if (!record) {
      return null;
    }

    const next: ComposerSubmissionRecord = {
      ...record,
      ...content,
      updatedAt: Date.now(),
      stages: withStage(record, 'amended', `${content.text.length} chars, ${content.files.length} files`),
    };
    await this.write(next);
    this.replace(next);
    return next;
  }

  /** Record a fresh attempt at an already-journalled composition. */
  async retry(id: string): Promise<ComposerSubmissionRecord | null> {
    const record = this.records().find((candidate) => candidate.id === id);
    if (!record) {
      return null;
    }

    const next: ComposerSubmissionRecord = {
      ...record,
      status: 'pending',
      updatedAt: Date.now(),
      attempts: record.attempts + 1,
      lastError: null,
      stages: withStage(record, 'retry', `attempt ${record.attempts + 1}`),
    };
    await this.write(next);
    this.replace(next);
    return next;
  }

  /**
   * The main process returned an instance id. The composition is now durable
   * on that side, so the journal entry — and the staged attachments with it —
   * can go.
   */
  async markAccepted(id: string, instanceId: string): Promise<void> {
    this.stageOnly(id, 'accepted', instanceId);
    await this.remove(id);
  }

  /**
   * Accept only while the record is still settled (not `pending`).
   *
   * A create that answers after the composer gave up still means the session
   * exists, so the entry is no longer unsent. But if a Retry has re-opened the
   * record since, that retry owns it — removing it here would leave the retry
   * with no recoverable entry should it fail.
   */
  async acceptIfStillSettled(id: string, instanceId: string): Promise<void> {
    const record = this.records().find((candidate) => candidate.id === id);
    if (record?.status === 'pending') {
      return;
    }
    await this.markAccepted(id, instanceId);
  }

  /** The attempt failed. Keep the composition and surface it for retry. */
  async markFailed(id: string, error: string): Promise<ComposerSubmissionRecord | null> {
    const record = this.records().find((candidate) => candidate.id === id);
    if (!record) {
      return null;
    }

    const next: ComposerSubmissionRecord = {
      ...record,
      status: 'failed',
      updatedAt: Date.now(),
      lastError: error,
      stages: withStage(record, 'failed', error),
    };
    await this.write(next);
    this.replace(next);
    console.warn('[composer-submission] failed', {
      submissionId: id,
      error,
      attempts: next.attempts,
      stages: next.stages,
    });
    return next;
  }

  /** The user chose to throw the composition away. */
  async discard(id: string): Promise<void> {
    this.stageOnly(id, 'discarded');
    await this.remove(id);
  }

  private async runRestore(): Promise<void> {
    const stored = await this.storage.list();
    const kept = await this.pruneStale(stored);
    const restored: ComposerSubmissionRecord[] = [];
    // Submissions started in THIS session are legitimately still pending — only
    // entries left behind by a renderer that went away are orphans.
    const liveIds = new Set(this.records().map((record) => record.id));

    for (const record of kept) {
      if (record.status !== 'pending' || liveIds.has(record.id)) {
        restored.push(record);
        continue;
      }

      const orphaned: ComposerSubmissionRecord = {
        ...record,
        status: 'failed',
        updatedAt: Date.now(),
        lastError: APP_CLOSED_WHILE_PENDING,
        stages: withStage(record, 'orphaned'),
      };
      await this.write(orphaned);
      restored.push(orphaned);
    }

    const unsent = restored.filter((record) => record.status === 'failed');
    if (unsent.length > 0) {
      console.warn('[composer-submission] recovered unsent compositions', {
        count: unsent.length,
        submissionIds: unsent.map((record) => record.id),
      });
    }
    // Merge, don't replace: a `begin()` that landed while the (awaited) storage
    // read was in flight is not in this snapshot and must not be dropped.
    const restoredById = new Map(restored.map((record) => [record.id, record]));
    this.records.update((current) => [
      ...restored,
      ...current.filter((record) => !restoredById.has(record.id)),
    ]);
    for (const record of restored) {
      if (!liveIds.has(record.id)) {
        this.restoredIds.add(record.id);
      }
    }
  }

  /** Append a stage to a record that is about to be removed, for the warn trail. */
  private stageOnly(id: string, stage: ComposerSubmissionStage, detail?: string): void {
    const record = this.records().find((candidate) => candidate.id === id);
    if (record) {
      this.replace({ ...record, stages: withStage(record, stage, detail) });
    }
  }

  /**
   * Drop journal entries that are too old or beyond the count cap.
   *
   * Runs once per session, at restore. Newest wins on the count cap so the
   * compositions a user is most likely to still want are the ones retained.
   */
  private async pruneStale(
    stored: ComposerSubmissionRecord[],
  ): Promise<ComposerSubmissionRecord[]> {
    const cutoff = Date.now() - COMPOSER_SUBMISSION_MAX_AGE_MS;
    const byRecency = [...stored].sort((a, b) => b.updatedAt - a.updatedAt);
    const kept = byRecency
      .filter((record) => record.updatedAt >= cutoff)
      .slice(0, COMPOSER_SUBMISSION_MAX_RECORDS);
    const keptIds = new Set(kept.map((record) => record.id));
    const dropped = stored.filter((record) => !keptIds.has(record.id));

    for (const record of dropped) {
      try {
        await this.storage.delete(record.id);
      } catch (error) {
        console.warn('[composer-submission] failed to prune journal entry', { id: record.id, error });
      }
    }

    if (dropped.length > 0) {
      console.warn('[composer-submission] pruned expired unsent compositions', {
        dropped: dropped.length,
        kept: kept.length,
      });
    }

    return kept;
  }

  private replace(record: ComposerSubmissionRecord): void {
    this.records.update((current) =>
      current.map((candidate) => (candidate.id === record.id ? record : candidate)),
    );
  }

  private async remove(id: string): Promise<void> {
    try {
      await this.storage.delete(id);
    } catch (error) {
      console.warn('[composer-submission] failed to delete journal entry', { id, error });
    }
    this.records.update((current) => current.filter((candidate) => candidate.id !== id));
    this.restoredIds.delete(id);
  }

  private async write(record: ComposerSubmissionRecord): Promise<void> {
    try {
      await this.storage.put(record);
    } catch (error) {
      // Durability is best-effort: losing the journal write must not also lose
      // the send. The in-memory copy still drives retry within this session.
      console.warn('[composer-submission] failed to persist journal entry', { id: record.id, error });
    }
  }
}
