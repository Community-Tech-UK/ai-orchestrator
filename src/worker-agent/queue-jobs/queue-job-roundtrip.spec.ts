import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRANCH, JOB, PROJECT, commitAll, documents, makeFixture, runGit, sendAndPrepare, sendCommit, writeFile, type Fixture,
} from './queue-job-fixture.test-helpers';

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());

/** Two turns the way this Mac drives them: send, prepare, (agent works), collect, save here, send back, clean up. */
describe('a job over two turns', () => {
  it('carries work out and back, and a file this Mac left out of its save does not come back', async () => {
    const turn1 = await sendAndPrepare(fx, { docs: { 'docs/plans/p_plan.md': 'v1\n' } });
    const folder = turn1.prepared.jobFolder;
    writeFile(folder, 'src/a.txt', 'turn one\n');
    writeFile(folder, 'docs/plans/stray_plan.md', 'a planning file in the wrong place\n');
    writeFile(turn1.prepared.planningFolder, 'docs/plans/p_plan.md', 'v2 by the agent\n');

    const collected1 = await fx.host.collect({ project: PROJECT, jobId: JOB, branch: BRANCH, expectedParent: turn1.commit });
    if ('refused' in collected1) throw new Error(collected1.refused.message);
    expect(runGit(['diff', '--name-only', turn1.commit, collected1.commit], join(fx.root, 'queue-repos', `${PROJECT}.git`)).split('\n').sort())
      .toEqual(['docs/plans/stray_plan.md', 'src/a.txt']);

    // This Mac saves: it applies src/a.txt, moves the stray planning file out of the commit, and sends the result back.
    writeFile(fx.mac, 'src/a.txt', 'turn one\n');
    const saved = commitAll(fx.mac, 'round 1 work');
    await sendCommit(fx, { commit: saved, have: [turn1.commit], startCommit: turn1.commit });
    expect(await fx.host.deleteLeftOut({ project: PROJECT, jobId: JOB, branch: BRANCH, files: ['docs/plans/stray_plan.md'] }))
      .toEqual({ deleted: ['docs/plans/stray_plan.md'], skipped: [] });

    const turn2 = await fx.host.prepare({
      project: PROJECT, jobId: JOB, branch: BRANCH, commit: saved, turnId: 'turn-2', documents: documents({ 'docs/plans/p_plan.md': 'v2 by the agent\n' }),
    });
    expect(turn2.jobFolder).toBe(folder);
    expect(runGit(['rev-parse', 'HEAD'], folder)).toBe(saved);
    expect(existsSync(join(folder, 'docs', 'plans', 'stray_plan.md'))).toBe(false);
    expect(readFileSync(join(folder, 'src', 'a.txt'), 'utf8')).toBe('turn one\n');
    expect(turn2.installed).toBe(false);

    writeFile(folder, 'src/b.txt', 'turn two\n');
    const collected2 = await fx.host.collect({ project: PROJECT, jobId: JOB, branch: BRANCH, expectedParent: saved });
    if ('refused' in collected2) throw new Error(collected2.refused.message);
    expect(runGit(['diff', '--name-only', saved, collected2.commit], join(fx.root, 'queue-repos', `${PROJECT}.git`))).toBe('src/b.txt');
    expect(collected2.documents).toEqual([]); // the plan matches what was sent this turn

    // The start reference never moved, and the job can be taken away cleanly.
    expect(runGit(['rev-parse', `refs/queue/${JOB}/start`], join(fx.root, 'queue-repos', `${PROJECT}.git`))).toBe(turn1.commit);
    expect(await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: true });
    rmSync(join(fx.root, 'queue-docs'), { recursive: true, force: true });
  });
});
