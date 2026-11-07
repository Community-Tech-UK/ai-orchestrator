import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { repeatedStopNote } from './plan-queue-document-memory';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem } from './plan-queue.types';

const DAY = 24 * 60 * 60_000;
let folder: string;
let document: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'queue-document-memory-'));
  document = join(folder, 'work_plan.md');
  writeFileSync(document, '# Work\n');
  utimesSync(document, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

const attempt = (id: string, patch: Partial<PlanQueueItem>): PlanQueueItem => ({
  ...newPlanQueueItem(id, 'run', document, 1, { state: 'parked', parkReason: 'worktree-error', detail: 'The checks could not start in /tmp/one.' }),
  updatedAt: Date.now() - DAY, ...patch,
});
const note = (...attempts: PlanQueueItem[]) => repeatedStopNote({ latestAttempts: () => attempts, lastParkedAt: () => Date.now() - DAY }, document);

describe('repeatedStopNote', () => {
  it('leaves out a document stopped twice the same way, even when paths in the wording differ', () => {
    expect(note(attempt('b', {}), attempt('a', { detail: 'The checks could not start in /tmp/two.' }))).toContain('Pick it by name');
  });

  it('counts wording that names the computer, whatever the stop is called', () => {
    const stop = { parkReason: 'worker-error' as const, detail: 'npm: command not found' };
    expect(note(attempt('b', stop), attempt('a', stop))).not.toBeNull();
  });

  it.each([
    ['only one attempt exists', [attempt('a', {})]],
    ['the two stops differ', [attempt('b', {}), attempt('a', { parkReason: 'provider-limit' })]],
    ['the wording differs', [attempt('b', {}), attempt('a', { detail: 'Something else entirely.' })]],
    ['the code was at fault', [attempt('b', { parkReason: 'round-limit', detail: 'Checks still fail.' }), attempt('a', { parkReason: 'round-limit', detail: 'Checks still fail.' })]],
    ['the last attempt landed', [attempt('b', { state: 'landed', parkReason: null }), attempt('a', {})]],
  ])('starts the document when %s', (_name, attempts) => {
    expect(note(...attempts)).toBeNull();
  });

  it('starts a document edited since the last attempt', () => {
    writeFileSync(document, '# Changed\n');
    expect(note(attempt('b', {}), attempt('a', {}))).toBeNull();
  });

  it('goes by when the attempt stopped, because discarding one later moves its save time', () => {
    writeFileSync(document, '# Changed\n');
    expect(note(attempt('b', { updatedAt: Date.now() + DAY }), attempt('a', {}))).toBeNull();
  });

  it('starts a document that has gone, so the usual missing-document stop reports it', () => {
    rmSync(document);
    expect(note(attempt('b', {}), attempt('a', {}))).toBeNull();
  });
});
