import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerSubmissionService } from '../../core/services/composer-submission.service';
import { MemoryComposerSubmissionStorage } from '../../core/services/composer-submission-store';
import { makeService } from '../../core/services/composer-submission.test-util';
import {
  retryNewSession,
  submitNewSession,
  type NewSessionSubmitRequest,
} from './input-panel-new-session-submit';
import type { ComposerSubmissionRecord } from '../../core/services/composer-submission.types';

function makeScreenshot(index: number): File {
  const bytes = new Uint8Array(750_000);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return new File([bytes], `pasted-image-${index}.png`, { type: 'image/png' });
}

const LONG_PROMPT =
  'None of the Community Tech automations are working — see the screenshots.\n'.repeat(300);

interface Harness {
  service: ComposerSubmissionService;
  storage: MemoryComposerSubmissionStorage;
  composerCleared: number;
  submitting: boolean[];
  submitError: (string | null)[];
  emitted: NewSessionSubmitRequest[];
  /** Live composer content the retry path reads. */
  composer: { text: string; files: File[]; folders: string[] };
  run: (options?: { throwOnEmit?: Error; ackTimeoutMs?: number }) => Promise<boolean>;
  retry: (record: ComposerSubmissionRecord, ackTimeoutMs?: number) => Promise<boolean>;
}

function createHarness(files: File[] = [0, 1, 2, 3, 4, 5].map(makeScreenshot)): Harness {
  const storage = new MemoryComposerSubmissionStorage();
  const service = makeService(storage);
  const harness: Harness = {
    service,
    storage,
    composerCleared: 0,
    submitting: [],
    submitError: [],
    emitted: [],
    composer: { text: LONG_PROMPT, files, folders: [] },
    retry: (record, ackTimeoutMs = 60_000) =>
      retryNewSession(
        {
          isSubmitting: () => false,
          retry: (id) => service.retry(id),
          currentText: () => harness.composer.text,
          currentFiles: () => harness.composer.files,
          currentFolders: () => harness.composer.folders,
          amend: (id, content) => service.amend(id, content),
          accept: (id, instanceId) => service.markAccepted(id, instanceId),
          fail: async (id, error) => {
            await service.markFailed(id, error);
          },
          emit: (request) => harness.emitted.push(request),
          setSubmitting: (value) => harness.submitting.push(value),
          setSubmitError: (value) => harness.submitError.push(value),
          clearComposer: () => {
            harness.composerCleared += 1;
          },
        },
        record,
        ackTimeoutMs,
      ),
    run: (options = {}) =>
      submitNewSession(
        {
          begin: () =>
            service.begin({
              draftKey: 'project:/Users/suas/work/communitytech',
              workingDirectory: '/Users/suas/work/communitytech',
              text: LONG_PROMPT,
              pendingFolders: [],
              files,
            }),
          accept: (id, instanceId) => service.markAccepted(id, instanceId),
          fail: async (id, error) => {
            await service.markFailed(id, error);
          },
          emit: (request) => {
            harness.emitted.push(request);
            if (options.throwOnEmit) throw options.throwOnEmit;
          },
          setSubmitting: (value) => harness.submitting.push(value),
          setSubmitError: (value) => harness.submitError.push(value),
          clearComposer: () => {
            harness.composerCleared += 1;
          },
        },
        options.ackTimeoutMs ?? 60_000,
      ),
  };
  return harness;
}

describe('submitNewSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends a long prompt with six screenshots and clears only after an instance id', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);

    // Emitted, but nothing cleared: the composer still owns the composition.
    expect(harness.emitted).toHaveLength(1);
    expect(harness.emitted[0].text).toBe(LONG_PROMPT);
    expect(harness.composerCleared).toBe(0);
    expect(harness.submitting).toEqual([true]);
    expect(await harness.storage.list()).toHaveLength(1);

    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-42' });

    await expect(promise).resolves.toBe(true);
    expect(harness.composerCleared).toBe(1);
    expect(harness.submitting).toEqual([true, false]);
    // Journal and staged attachments cleaned up only on confirmed acceptance.
    await vi.advanceTimersByTimeAsync(0);
    expect(await harness.storage.list()).toEqual([]);
  });

  it('holds the composition while the acknowledgement is delayed', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(harness.composerCleared).toBe(0);
    expect(await harness.storage.list()).toHaveLength(1);

    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-slow' });
    await expect(promise).resolves.toBe(true);
    expect(harness.composerCleared).toBe(1);
  });

  it('keeps text and attachments when the IPC call is rejected', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);

    harness.emitted[0].onResolved({
      ok: false,
      error: 'IPC validation failed for INSTANCE_CREATE_WITH_MESSAGE: attachments: too big',
    });

    await expect(promise).resolves.toBe(false);
    expect(harness.composerCleared).toBe(0);
    expect(harness.submitError.at(-1)).toContain('IPC validation failed');

    await vi.advanceTimersByTimeAsync(0);
    const recovered = harness.service.recoverableFor('project:/Users/suas/work/communitytech');
    expect(recovered?.files).toHaveLength(6);
    expect(recovered?.text).toBe(LONG_PROMPT);
  });

  it('fails closed when the main process never acknowledges', async () => {
    const harness = createHarness();
    const promise = harness.run({ ackTimeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(promise).resolves.toBe(false);
    expect(harness.composerCleared).toBe(0);
    expect(harness.submitError.at(-1)).toMatch(/not confirmed within 60 seconds/);
    expect(harness.service.recoverableFor('project:/Users/suas/work/communitytech')?.files)
      .toHaveLength(6);
  });

  it('recovers when the handler throws synchronously instead of resolving', async () => {
    const harness = createHarness();
    const promise = harness.run({ throwOnEmit: new Error('handler exploded') });
    await vi.advanceTimersByTimeAsync(0);

    await expect(promise).resolves.toBe(false);
    expect(harness.composerCleared).toBe(0);
    expect(harness.submitError.at(-1)).toBe('handler exploded');
  });

  it('ignores a late acknowledgement after the submission already settled', async () => {
    const harness = createHarness();
    const promise = harness.run({ ackTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(promise).resolves.toBe(false);
    expect(harness.composerCleared).toBe(0);

    // The parent finally answers — this must NOT clear a composer the user has
    // since refilled, and must not flip the submitting flag again.
    const submittingCalls = harness.submitting.length;
    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-late' });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.composerCleared).toBe(0);
    expect(harness.submitting).toHaveLength(submittingCalls);
  });

  it('survives the component going away mid-submission', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);

    // The welcome view is swapped for the "Starting conversation…" spinner
    // while creating, which destroys the composer. The journal is what carries
    // the composition across that unmount.
    const journalled = await harness.storage.list();
    expect(journalled).toHaveLength(1);
    expect(journalled[0].files).toHaveLength(6);
    expect(journalled[0].text).toBe(LONG_PROMPT);

    // A fresh service over the same storage stands in for the remounted panel.
    const remounted = makeService(harness.storage);
    await remounted.restore();
    expect(remounted.recoverableFor('project:/Users/suas/work/communitytech')?.files)
      .toHaveLength(6);

    harness.emitted[0].onResolved({ ok: false, error: 'gone' });
    await expect(promise).resolves.toBe(false);
  });

  it('reuses the correlation id as the retry key so a retry cannot duplicate a session', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);
    const firstId = harness.emitted[0].submissionId;

    harness.emitted[0].onResolved({ ok: false, error: 'timed out' });
    await promise;
    await vi.advanceTimersByTimeAsync(0);

    const retried = await harness.service.retry(firstId);
    expect(retried?.id).toBe(firstId);
    expect(retried?.attempts).toBe(2);
  });
});

describe('submitNewSession — gate regressions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('marks itself submitting before the journal write, closing the double-submit window', async () => {
    const harness = createHarness();
    const promise = harness.run();

    // Synchronously after the call, before begin() has resolved. `canSend()`
    // reads this flag; the pre-fix ordering left it false across two IndexedDB
    // round-trips, so a second Enter started a second submission with a
    // different id that the main-process cache could not deduplicate.
    expect(harness.submitting[0]).toBe(true);
    expect(harness.emitted).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-1' });
    await promise;
  });

  it('carries the journalled attachments on the request, not just the text', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);

    // The handler must not read the live draft: after a restart the in-memory
    // pendingFiles are gone and it would send a text-only message.
    expect(harness.emitted[0].files).toHaveLength(6);
    expect(harness.emitted[0].files.map((f) => f.name)).toContain('pasted-image-3.png');
    expect(harness.emitted[0].pendingFolders).toEqual([]);

    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-1' });
    await promise;
  });

  it('retries a composition recovered after a restart using its journalled files', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);
    harness.emitted[0].onResolved({ ok: false, error: 'boom' });
    await promise;
    await vi.advanceTimersByTimeAsync(0);

    const recovered = harness.service.recoverableFor('project:/Users/suas/work/communitytech');
    expect(recovered).not.toBeNull();

    // Composer is empty, as it is after a reload — the journal is the only copy.
    harness.composer = { text: '', files: [], folders: [] };
    const retryPromise = harness.retry(recovered!);
    await vi.advanceTimersByTimeAsync(0);

    const retried = harness.emitted.at(-1)!;
    expect(retried.submissionId).toBe(recovered!.id);
    expect(retried.text).toBe(LONG_PROMPT);
    expect(retried.files).toHaveLength(6);

    retried.onResolved({ ok: true, instanceId: 'inst-2' });
    await expect(retryPromise).resolves.toBe(true);
  });

  it('retries with the edited composer content rather than the stale journalled text', async () => {
    const harness = createHarness();
    const promise = harness.run();
    await vi.advanceTimersByTimeAsync(0);
    harness.emitted[0].onResolved({ ok: false, error: 'boom' });
    await promise;
    await vi.advanceTimersByTimeAsync(0);

    const recovered = harness.service.recoverableFor('project:/Users/suas/work/communitytech')!;
    harness.composer = { text: 'edited after the failure', files: [makeScreenshot(9)], folders: ['plans'] };

    const retryPromise = harness.retry(recovered);
    await vi.advanceTimersByTimeAsync(0);

    const retried = harness.emitted.at(-1)!;
    expect(retried.submissionId).toBe(recovered.id); // same id → still deduped
    expect(retried.text).toBe('edited after the failure');
    expect(retried.files.map((f) => f.name)).toEqual(['pasted-image-9.png']);
    expect(retried.pendingFolders).toEqual(['plans']);

    retried.onResolved({ ok: true, instanceId: 'inst-3' });
    await retryPromise;
  });

  it('notifies the handler on timeout so in-flight UI can be dismissed', async () => {
    const harness = createHarness();
    let timedOut = false;
    const promise = harness.run({ ackTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    harness.emitted[0].onTimeout(() => {
      timedOut = true;
    });

    await vi.advanceTimersByTimeAsync(1_001);

    // Without this the "Starting conversation…" view stays up, unmounting the
    // composer and hiding the recovery banner behind a permanent spinner.
    expect(timedOut).toBe(true);
    await expect(promise).resolves.toBe(false);
  });

  it('cleans up the journal when a success arrives after the timeout, without clearing the composer', async () => {
    const harness = createHarness();
    const promise = harness.run({ ackTimeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(promise).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.service.recoverable()).toHaveLength(1);

    // A slow spawn finally lands. The session exists, so the composition is no
    // longer unsent — leaving it would show a permanent "not sent" banner for a
    // session that was created.
    harness.emitted[0].onResolved({ ok: true, instanceId: 'inst-late' });
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.service.recoverable()).toEqual([]);
    // The user may have refilled the composer since; it must not be wiped.
    expect(harness.composerCleared).toBe(0);
  });

  it('reports a journal write that throws instead of hanging in the submitting state', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    const service = makeService(storage);
    const submitting: boolean[] = [];
    const errors: (string | null)[] = [];

    const ok = await submitNewSession({
      begin: () => Promise.reject(new Error('journal unavailable')),
      accept: (id, instanceId) => service.markAccepted(id, instanceId),
      fail: async () => undefined,
      emit: () => undefined,
      setSubmitting: (value) => submitting.push(value),
      setSubmitError: (value) => errors.push(value),
      clearComposer: () => {
        throw new Error('must not clear');
      },
    });

    expect(ok).toBe(false);
    expect(submitting).toEqual([true, false]);
    expect(errors.at(-1)).toBe('journal unavailable');
  });
});
