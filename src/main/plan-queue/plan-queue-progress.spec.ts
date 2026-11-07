import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideNoProgress, documentContentSha256 } from './plan-queue-progress';
import { newPlanQueueItem } from './plan-queue-state';

let folder: string;
let document: string;
beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'queue-progress-'));
  document = join(folder, 'work_plan.md');
  writeFileSync(document, '# Work\n');
});
afterEach(() => rmSync(folder, { recursive: true, force: true }));

describe('decideNoProgress', () => {
  const failed = async () => [{ verdict: 'FAIL', worktreeHead: 'head', documentSha256: await documentContentSha256(document), round: 1, findings: [] }];
  const item = (round: number) => newPlanQueueItem('item', 'run', document, 1, { round, checkpointCommit: 'head' });

  it('stops a job that changed nothing since its last failed check', async () => {
    const rows = await failed();
    expect((await decideNoProgress(rows as never, item(1), false)).kind).not.toBe('continue');
  });

  it('always runs the first check after a Resume, because the failure may have been the computer', async () => {
    const rows = await failed();
    expect((await decideNoProgress(rows as never, item(0), false)).kind).toBe('continue');
  });
});
