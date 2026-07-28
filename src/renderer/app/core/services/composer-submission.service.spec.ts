import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerSubmissionService } from './composer-submission.service';
import { MemoryComposerSubmissionStorage } from './composer-submission-store';
import { makeService } from './composer-submission.test-util';
import type {
  ComposerSubmissionRecord,
  ComposerSubmissionStorage,
} from './composer-submission.types';

/**
 * Realistic screenshot-sized PNG bytes.
 *
 * The incident involved five-plus real screenshots, so the fixtures are actual
 * `File` objects of a plausible size rather than one-character strings — a
 * mocked stub would not exercise the storage round-trip the fix depends on.
 */
function makeScreenshot(index: number, bytes = 900_000): File {
  const payload = new Uint8Array(bytes);
  // PNG magic so `type`/content are at least self-consistent.
  payload.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  for (let i = 8; i < bytes; i += 7919) {
    payload[i] = (i + index) % 256;
  }
  return new File([payload], `pasted-image-${index}.png`, { type: 'image/png' });
}

function makeLongPrompt(): string {
  return (
    'None of the Community Tech automations are working. ' +
    'Here is what I am seeing across the board:\n'.repeat(400)
  );
}

describe('ComposerSubmissionService', () => {
  let storage: MemoryComposerSubmissionStorage;
  let service: ComposerSubmissionService;

  beforeEach(() => {
    storage = new MemoryComposerSubmissionStorage();
    service = makeService(storage);
  });

  const baseInput = (overrides: Partial<Parameters<ComposerSubmissionService['begin']>[0]> = {}) => ({
    draftKey: 'project:/Users/suas/work/communitytech',
    workingDirectory: '/Users/suas/work/communitytech',
    text: makeLongPrompt(),
    pendingFolders: [] as string[],
    files: [0, 1, 2, 3, 4, 5].map((index) => makeScreenshot(index)),
    ...overrides,
  });

  it('journals a long prompt with six screenshots before anything is emitted', async () => {
    const input = baseInput();

    const record = await service.begin(input);

    expect(record.status).toBe('pending');
    expect(record.text).toHaveLength(input.text.length);
    expect(record.files).toHaveLength(6);

    // Durable *before* begin() resolves — the composer clears against this.
    const stored = await storage.list();
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(record.id);
    expect(stored[0].files.map((f) => f.name)).toEqual([
      'pasted-image-0.png',
      'pasted-image-1.png',
      'pasted-image-2.png',
      'pasted-image-3.png',
      'pasted-image-4.png',
      'pasted-image-5.png',
    ]);
    expect(stored[0].files[0].size).toBe(900_000);
  });

  it('deletes the journal entry and its attachments once an instance id comes back', async () => {
    const record = await service.begin(baseInput());

    await service.markAccepted(record.id, 'inst-abc');

    expect(await storage.list()).toEqual([]);
    expect(service.recoverable()).toEqual([]);
    expect(service.pending()).toEqual([]);
  });

  it('keeps the composition recoverable when the attempt fails', async () => {
    const record = await service.begin(baseInput());

    await service.markFailed(record.id, 'IPC validation failed');

    const recoverable = service.recoverableFor('project:/Users/suas/work/communitytech');
    expect(recoverable?.id).toBe(record.id);
    expect(recoverable?.lastError).toBe('IPC validation failed');
    expect(recoverable?.files).toHaveLength(6);
    expect(await storage.list()).toHaveLength(1);
  });

  it('restores an interrupted submission after a reload as recoverable, not pending', async () => {
    const first = makeService(storage);
    const record = await first.begin(baseInput());
    expect(record.status).toBe('pending');

    // A fresh service over the same storage stands in for a renderer reload or
    // an application restart.
    const revived = makeService(storage);
    await revived.restore();

    const recovered = revived.recoverableFor('project:/Users/suas/work/communitytech');
    expect(recovered?.id).toBe(record.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.lastError).toMatch(/never sent/i);
    expect(recovered?.files).toHaveLength(6);
    expect(revived.pending()).toEqual([]);
  });

  it('does not resurrect a submission that was already accepted', async () => {
    const first = makeService(storage);
    const record = await first.begin(baseInput());
    await first.markAccepted(record.id, 'inst-abc');

    const revived = makeService(storage);
    await revived.restore();

    expect(revived.recoverable()).toEqual([]);
  });

  it('counts attempts across retries and reuses the same correlation id', async () => {
    const record = await service.begin(baseInput());
    await service.markFailed(record.id, 'first failure');

    const retried = await service.retry(record.id);

    expect(retried?.id).toBe(record.id);
    expect(retried?.attempts).toBe(2);
    expect(retried?.status).toBe('pending');
    expect(retried?.lastError).toBeNull();
  });

  it('keeps a newer draft submission separate when an older one resolves late', async () => {
    const older = await service.begin(baseInput({ text: 'older composition' }));
    const newer = await service.begin(baseInput({ text: 'newer composition' }));

    // The older attempt finally answers, long after the user moved on.
    await service.markFailed(older.id, 'timed out');

    // The newer submission is untouched and still awaiting its own answer.
    expect(service.pending().map((record) => record.id)).toEqual([newer.id]);
    expect(service.recoverableFor(older.draftKey)?.id).toBe(older.id);

    // Accepting the older one must not remove the newer one.
    await service.markAccepted(older.id, 'inst-old');
    expect(service.pending().map((record) => record.id)).toEqual([newer.id]);
  });

  it('supersedes an earlier unsent attempt when the user sends again', async () => {
    const first = await service.begin(baseInput({ text: 'original text' }));
    await service.markFailed(first.id, 'boom');
    expect(service.recoverableFor(first.draftKey)?.id).toBe(first.id);

    // The composer was never cleared, so pressing Send again carries the same
    // (possibly edited) content. Retrying the stale record would send old text.
    const second = await service.begin(baseInput({ text: 'edited text' }));

    expect(service.recoverable()).toEqual([]);
    expect(service.pending().map((record) => record.id)).toEqual([second.id]);
    expect((await storage.list()).map((record) => record.id)).toEqual([second.id]);
  });

  it('leaves other draft keys alone when superseding', async () => {
    const other = await service.begin(
      baseInput({ draftKey: 'project:/Users/suas/work/other', text: 'other' }),
    );
    await service.markFailed(other.id, 'boom');

    await service.begin(baseInput({ text: 'communitytech' }));

    expect(service.recoverableFor('project:/Users/suas/work/other')?.id).toBe(other.id);
  });

  it('returns the most recently updated unsent composition for a draft key', async () => {
    const first = await service.begin(baseInput({ text: 'first' }));
    const second = await service.begin(baseInput({ text: 'second' }));
    await service.markFailed(first.id, 'a');
    await service.markFailed(second.id, 'b');

    expect(service.recoverableFor(first.draftKey)?.id).toBe(second.id);
  });

  it('ignores other draft keys', async () => {
    const record = await service.begin(baseInput());
    await service.markFailed(record.id, 'nope');

    expect(service.recoverableFor('project:/Users/suas/work/other')).toBeNull();
  });

  it('still returns a usable record when the durable write fails', async () => {
    const failing: ComposerSubmissionStorage = {
      list: async () => [],
      put: async () => {
        throw new Error('QuotaExceededError');
      },
      delete: async () => undefined,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const degraded = makeService(failing);

    const record = await degraded.begin(baseInput());

    // Losing durability must not also lose the send: the in-memory record still
    // drives retry for this session.
    expect(record.status).toBe('pending');
    expect(degraded.pending()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps a correlated stage trail on the durable record', async () => {
    const record = await service.begin(baseInput());
    await service.markFailed(record.id, 'IPC validation failed');
    await service.retry(record.id);
    await service.markFailed(record.id, 'timed out');

    const trail = service.recoverableFor(record.draftKey);
    expect(trail?.id).toBe(record.id);
    expect(trail?.stages.map((event) => event.stage)).toEqual([
      'begin',
      'failed',
      'retry',
      'failed',
    ]);
    expect(trail?.stages[0].detail).toMatch(/chars, 6 files$/);
    expect(trail?.stages[3].detail).toBe('timed out');
    // The trail is durable, so it is still readable after a reload.
    expect((await storage.list())[0].stages).toHaveLength(4);
  });

  it('tolerates a journal entry written before stage tracking existed', async () => {
    const legacy = {
      ...baseInput(),
      id: 'legacy-1',
      status: 'pending' as const,
      createdAt: Date.now() - 60_000,
      updatedAt: Date.now() - 60_000,
      attempts: 1,
      lastError: null,
    } as unknown as Parameters<MemoryComposerSubmissionStorage['put']>[0];
    await storage.put(legacy);

    const revived = makeService(storage);
    await revived.restore();

    const recovered = revived.recoverableFor('project:/Users/suas/work/communitytech');
    expect(recovered?.id).toBe('legacy-1');
    expect(recovered?.stages.map((event) => event.stage)).toEqual(['orphaned']);
  });

  it('drops a discarded composition', async () => {
    const record = await service.begin(baseInput());
    await service.markFailed(record.id, 'boom');

    await service.discard(record.id);

    expect(service.recoverable()).toEqual([]);
    expect(await storage.list()).toEqual([]);
  });

  it('shares a single restore pass between concurrent callers', async () => {
    const list = vi.fn<() => Promise<ComposerSubmissionRecord[]>>().mockResolvedValue([]);
    const spied = makeService({
      list,
      put: async () => undefined,
      delete: async () => undefined,
    });

    await Promise.all([spied.restore(), spied.restore(), spied.restore()]);

    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe('ComposerSubmissionService — gate regressions', () => {
  const draftKey = 'project:/Users/suas/work/communitytech';

  function makeInput(overrides: Record<string, unknown> = {}) {
    return {
      draftKey,
      workingDirectory: '/Users/suas/work/communitytech',
      text: 'a composition',
      pendingFolders: [] as string[],
      files: [0, 1].map((i) => makeScreenshot(i, 1_000)),
      ...overrides,
    };
  }

  it('never supersedes a composition recovered from a previous run', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    const first = makeService(storage);
    const orphan = await first.begin(makeInput({ text: 'lost prompt' }));

    // Restart: the composer is empty, so this record is the only copy.
    const revived = makeService(storage);
    await revived.restore();
    expect(revived.recoverableFor(draftKey)?.id).toBe(orphan.id);

    // The user types something new and sends it. Superseding here would delete
    // the recovered prompt and its images with no user action.
    const fresh = await revived.begin(makeInput({ text: 'a new prompt' }));

    expect(revived.recoverableFor(draftKey)?.id).toBe(orphan.id);
    expect(revived.pending().map((r) => r.id)).toEqual([fresh.id]);
    expect((await storage.list()).map((r) => r.id).sort()).toEqual([orphan.id, fresh.id].sort());
  });

  it('amend rewrites content but keeps the correlation id and records the stage', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    const service = makeService(storage);
    const record = await service.begin(makeInput());

    const amended = await service.amend(record.id, {
      text: 'edited',
      files: [makeScreenshot(7, 1_000)],
      pendingFolders: ['plans'],
    });

    expect(amended?.id).toBe(record.id);
    expect(amended?.text).toBe('edited');
    expect(amended?.files.map((f) => f.name)).toEqual(['pasted-image-7.png']);
    expect(amended?.pendingFolders).toEqual(['plans']);
    expect(amended?.stages.map((e) => e.stage)).toEqual(['begin', 'amended']);
    expect((await storage.list())[0].text).toBe('edited');
  });

  it('amend on an unknown id is a no-op', async () => {
    const service = makeService(new MemoryComposerSubmissionStorage());
    await expect(
      service.amend('nope', { text: 'x', files: [], pendingFolders: [] }),
    ).resolves.toBeNull();
  });

  it('keeps a record created while restore was still reading storage', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    let releaseList: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    const service = makeService({
      list: async () => {
        await gate;
        return storage.list();
      },
      put: (record) => storage.put(record),
      delete: (id) => storage.delete(id),
    });

    const restoring = service.restore();
    const raced = await service.begin(makeInput({ text: 'typed during restore' }));
    releaseList?.();
    await restoring;

    // Replacing (rather than merging) the record list here silently dropped the
    // in-flight submission, so its failure could never surface a banner.
    expect(service.pending().map((r) => r.id)).toContain(raced.id);
    await service.markFailed(raced.id, 'boom');
    expect(service.recoverableFor(draftKey)?.id).toBe(raced.id);
  });

  it('prunes journal entries past the age limit', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    const seeded = makeService(storage);
    const stale = await seeded.begin(makeInput({ text: 'ancient' }));
    const fresh = await seeded.begin(makeInput({ draftKey: 'project:/other', text: 'recent' }));

    const aged = (await storage.list()).find((r) => r.id === stale.id)!;
    await storage.put({ ...aged, updatedAt: Date.now() - 31 * 24 * 60 * 60_000 });

    const revived = makeService(storage);
    await revived.restore();

    // Records hold full image blobs; one whose draft key is never revisited is
    // never surfaced, so the journal needs a ceiling.
    expect((await storage.list()).map((r) => r.id)).toEqual([fresh.id]);
    expect(revived.recoverableFor(draftKey)).toBeNull();
  });

  it('prunes the oldest entries past the count cap', async () => {
    const storage = new MemoryComposerSubmissionStorage();
    const seeded = makeService(storage);
    for (let i = 0; i < 25; i++) {
      const record = await seeded.begin(makeInput({ draftKey: `project:/p${i}`, text: `p${i}` }));
      const stored = (await storage.list()).find((r) => r.id === record.id)!;
      await storage.put({ ...stored, updatedAt: Date.now() - (25 - i) * 60_000 });
    }

    const revived = makeService(storage);
    await revived.restore();

    const kept = await storage.list();
    expect(kept).toHaveLength(20);
    expect(kept.map((r) => r.text).sort()).not.toContain('p0');
    expect(revived.recoverableFor('project:/p24')).not.toBeNull();
  });
});
