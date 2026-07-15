import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { VerificationRunRecorder } from './verification-run-recorder';
import {
  VerificationRunStore,
  createVerificationRunSchema,
} from './verification-run-store';

describe('VerificationRunRecorder', () => {
  let db: SqliteDriver;
  let store: VerificationRunStore;

  beforeEach(() => {
    VerificationRunRecorder._resetForTesting();
    VerificationRunStore._resetForTesting();
    db = defaultDriverFactory(':memory:');
    createVerificationRunSchema(db);
    store = new VerificationRunStore(db);
  });

  afterEach(() => {
    VerificationRunRecorder._resetForTesting();
    VerificationRunStore._resetForTesting();
    db.close();
  });

  it('records the externalized full output path without putting the output in the ledger row', () => {
    const recorder = new VerificationRunRecorder({
      store,
      externalizeOutput: () => ({ content: 'preview', truncated: true, outputPath: '/tmp/verify-output.txt' }),
      now: () => 1_700_000_000_000,
    });

    recorder.record({
      scope: 'loop',
      loopRunId: 'loop-1',
      command: 'npm run test:quiet',
      cwd: '/workspace',
      exitCode: 0,
      durationMs: 420,
      workHash: 'hash-1',
      output: 'a very long test output',
    });

    expect(store.listForLoop('loop-1')).toEqual([expect.objectContaining({
      outputRef: '/tmp/verify-output.txt',
      exitCode: 0,
      startedAt: 1_700_000_000_000,
    })]);
  });
});
