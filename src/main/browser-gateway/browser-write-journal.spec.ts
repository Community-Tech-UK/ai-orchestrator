import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserWriteJournal } from './browser-write-journal';

describe('BrowserWriteJournal', () => {
  let rootDir: string;
  let journals: BrowserWriteJournal[];

  function createJournal(
    options: ConstructorParameters<typeof BrowserWriteJournal>[0] = {},
  ): BrowserWriteJournal {
    const journal = new BrowserWriteJournal(options);
    journals.push(journal);
    return journal;
  }

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bwj-'));
    journals = [];
    BrowserWriteJournal._resetForTesting();
  });

  afterEach(async () => {
    await Promise.all(journals.map((journal) => journal.flushPending()));
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('records intent + outcome and lists entries newest last', async () => {
    const journal = createJournal({ rootDir, now: () => 42 });
    const seq = await journal.recordIntent({
      profileId: 'profile-1',
      targetId: 'target-1',
      command: 'type',
      payload: { selector: '#headline', value: 'Fast Local Service' },
    });
    await journal.recordOutcome({
      profileId: 'profile-1',
      targetId: 'target-1',
      seq,
      outcome: 'succeeded',
      scan: { state: 'ok', checkedAt: 43 },
    });

    const entries = await journal.list('profile-1', 'target-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      seq: 1,
      command: 'type',
      selector: '#headline',
      approxValueLength: 24,
      outcome: 'succeeded',
      persistence: 'ok',
    });
  });

  it('never writes field values (or exact lengths) to disk', async () => {
    const journal = createJournal({ rootDir, now: () => 1 });
    await journal.recordIntent({
      profileId: 'profile-1',
      targetId: 'target-1',
      command: 'type',
      payload: { selector: '#password', value: 'hunter2-secret-value' },
    });
    await journal.flushPending();

    const files = await fs.readdir(rootDir);
    expect(files).toHaveLength(1);
    const raw = await fs.readFile(path.join(rootDir, files[0]), 'utf8');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain(String('hunter2-secret-value'.length));
    expect(raw).toContain('approxValueLength');
  });

  it('records failure outcomes with the reason and sentinel verdict', async () => {
    const journal = createJournal({ rootDir, now: () => 1 });
    const seq = await journal.recordIntent({
      profileId: 'profile-1',
      targetId: 'target-1',
      command: 'fill_form',
      payload: { fields: [{ selector: '#a', value: 'x' }, { selector: '#b', value: 'y' }] },
    });
    await journal.recordOutcome({
      profileId: 'profile-1',
      targetId: 'target-1',
      seq,
      outcome: 'succeeded',
      scan: { state: 'save_failed', matchedPattern: 'failed to save', checkedAt: 2 },
      reason: 'browser_target_save_rejected (…)',
    });

    const [entry] = await journal.list('profile-1', 'target-1');
    expect(entry).toMatchObject({
      command: 'fill_form',
      fieldCount: 2,
      persistence: 'save_failed',
      matchedPattern: 'failed to save',
    });
  });

  it('survives a restart (reloads entries and continues seq from disk)', async () => {
    const first = createJournal({ rootDir, now: () => 1 });
    const seq1 = await first.recordIntent({
      profileId: 'profile-1',
      targetId: 'target-1',
      command: 'click',
      payload: { uid: '104423' },
    });
    await first.flushPending();

    const second = createJournal({ rootDir, now: () => 2 });
    const seq2 = await second.recordIntent({
      profileId: 'profile-1',
      targetId: 'target-1',
      command: 'click',
    });
    expect(seq2).toBe(seq1 + 1);
    const entries = await second.list('profile-1', 'target-1');
    expect(entries.map((entry) => entry.seq)).toEqual([seq1, seq2]);
  });

  it('caps entries per target', async () => {
    const journal = createJournal({ rootDir, now: () => 1 });
    for (let i = 0; i < 210; i++) {
      await journal.recordIntent({
        profileId: 'profile-1',
        targetId: 'target-1',
        command: 'click',
      });
    }
    const entries = await journal.list('profile-1', 'target-1', 200);
    expect(entries).toHaveLength(200);
    expect(entries[0].seq).toBe(11);
  });

  it('starts fresh on a corrupt journal file', async () => {
    const first = createJournal({ rootDir, now: () => 1 });
    await first.recordIntent({ profileId: 'p', targetId: 't', command: 'click' });
    await first.flushPending();
    const [file] = await fs.readdir(rootDir);
    await fs.writeFile(path.join(rootDir, file), 'not json');

    const second = createJournal({ rootDir, now: () => 2 });
    expect(await second.list('p', 't')).toEqual([]);
  });
});
