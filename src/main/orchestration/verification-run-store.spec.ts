import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  VerificationRunStore,
  createVerificationRunSchema,
} from './verification-run-store';

describe('VerificationRunStore', () => {
  let db: SqliteDriver;
  let store: VerificationRunStore;

  beforeEach(() => {
    VerificationRunStore._resetForTesting();
    db = defaultDriverFactory(':memory:');
    createVerificationRunSchema(db);
    store = new VerificationRunStore(db);
  });

  afterEach(() => {
    VerificationRunStore._resetForTesting();
    db.close();
  });

  it('persists a loop verification with a canonical command and returns it newest first', () => {
    store.record({
      scope: 'loop',
      loopRunId: 'loop-1',
      command: 'npx vitest run',
      cwd: '/workspace',
      exitCode: 0,
      durationMs: 128,
      workHash: 'work-hash',
      startedAt: 1_700_000_000_000,
    });

    expect(store.listForLoop('loop-1')).toEqual([expect.objectContaining({
      scope: 'loop',
      loopRunId: 'loop-1',
      instanceId: null,
      command: 'npx vitest run',
      canonicalCommand: 'vitest run',
      cwd: '/workspace',
      exitCode: 0,
      durationMs: 128,
      workHash: 'work-hash',
      outputRef: null,
      startedAt: 1_700_000_000_000,
    })]);
  });

  it('keeps instance runs separate from loop runs', () => {
    store.record({
      scope: 'loop',
      loopRunId: 'loop-1',
      command: 'npm test',
      cwd: '/workspace',
      exitCode: 0,
      durationMs: 1,
      startedAt: 10,
    });
    store.record({
      scope: 'instance',
      instanceId: 'instance-1',
      command: 'npm test',
      cwd: '/workspace',
      exitCode: 1,
      durationMs: 2,
      startedAt: 20,
    });

    expect(store.listForLoop('loop-1')).toHaveLength(1);
    expect(store.listForInstance('instance-1')).toEqual([expect.objectContaining({
      scope: 'instance',
      loopRunId: null,
      instanceId: 'instance-1',
      exitCode: 1,
    })]);
  });
});
