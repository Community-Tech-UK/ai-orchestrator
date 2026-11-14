import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueueCollectResultSchema } from '../../main/remote-node/queue-job-rpc-schemas';
import {
  BRANCH, JOB, PROJECT, commitAll, makeFixture, runGit, sendAndPrepare, writeFile, type Fixture,
} from './queue-job-fixture.test-helpers';

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());

const bare = (): string => join(fx.root, 'queue-repos', `${PROJECT}.git`);

async function collected(parent: string, overrides: { branch?: string; jobId?: string } = {}) {
  const result = await fx.host.collect({ project: PROJECT, jobId: overrides.jobId ?? JOB, branch: overrides.branch ?? BRANCH, expectedParent: parent });
  expect(QueueCollectResultSchema.safeParse(result).success).toBe(true);
  return result;
}

/** What this Mac does with a collect: fetch every chunk, unpack the thin pack into its repository. */
async function fetchInto(repo: string, packId: string, chunks: number): Promise<void> {
  const parts: Buffer[] = [];
  for (let index = 0; index < chunks; index++) parts.push(Buffer.from((await fx.host.fetchPack({ packId, index })).dataBase64, 'base64'));
  runGit(['index-pack', '--stdin', '--fix-thin'], repo, Buffer.concat(parts));
}

describe('queue.collect', () => {
  it('records the agent\'s work on a side reference with the sent commit as parent, and returns a pack the Mac can unpack', async () => {
    const { commit, prepared } = await sendAndPrepare(fx, { docs: { 'docs/plans/p_plan.md': '# plan\n', 'docs/specs/old_spec.md': 'old\n' } });
    writeFile(prepared.jobFolder, 'src/a.txt', 'agent change\n');
    writeFile(prepared.jobFolder, 'src/new/deep.txt', 'brand new\n');
    rmSync(join(prepared.jobFolder, 'src', 'b.txt'));
    writeFile(prepared.planningFolder, 'docs/plans/p_plan.md', '# plan\nedited by the agent\n');
    writeFile(prepared.planningFolder, 'docs/plans/p_plan_livetest.md', 'created\n');
    rmSync(join(prepared.planningFolder, 'docs', 'specs', 'old_spec.md'));
    const before = {
      status: runGit(['status', '--porcelain'], prepared.jobFolder),
      index: readFileSync(join(runGit(['rev-parse', '--absolute-git-dir'], prepared.jobFolder), 'index')).toString('hex'),
    };

    const result = await collected(commit);
    if ('refused' in result) throw new Error(result.refused.message);
    expect(runGit(['rev-parse', `${result.commit}^`], bare())).toBe(commit);
    expect(runGit(['rev-parse', `refs/queue/${JOB}/collected`], bare())).toBe(result.commit);
    // Nothing moved: the branch, the folder's commit, its status and its own index.
    expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], bare())).toBe(commit);
    expect(runGit(['rev-parse', 'HEAD'], prepared.jobFolder)).toBe(commit);
    expect(runGit(['status', '--porcelain'], prepared.jobFolder)).toBe(before.status);
    expect(readFileSync(join(runGit(['rev-parse', '--absolute-git-dir'], prepared.jobFolder), 'index')).toString('hex')).toBe(before.index);
    expect(readFileSync(join(prepared.jobFolder, 'src', 'a.txt'), 'utf8')).toBe('agent change\n');

    expect(runGit(['diff', '--name-status', commit, result.commit], bare())).toBe('M\tsrc/a.txt\nD\tsrc/b.txt\nA\tsrc/new/deep.txt');

    // Planning files: only what changed or is new, whole, plus what was sent and is gone.
    expect(result.documents.map(d => [d.path, Buffer.from(d.contentBase64, 'base64').toString()])).toEqual([
      ['docs/plans/p_plan.md', '# plan\nedited by the agent\n'],
      ['docs/plans/p_plan_livetest.md', 'created\n'],
    ]);
    expect(result.deleted).toEqual(['docs/specs/old_spec.md']);

    // This Mac unpacks the thin pack and has the commit.
    runGit(['cat-file', '-e', `${commit}^{commit}`], fx.mac);
    await fetchInto(fx.mac, result.packId, result.packChunks);
    expect(runGit(['cat-file', '-p', `${result.commit}:src/new/deep.txt`], fx.mac)).toBe('brand new');
    expect(runGit(['rev-parse', `${result.commit}^`], fx.mac)).toBe(commit);
  });

  it('leaves out installed files and every path setup left in the folder', async () => {
    runGit(['rm', '-q', '--cached', '.gitignore'], fx.mac);
    rmSync(join(fx.mac, '.gitignore'));
    const noIgnore = commitAll(fx.mac, 'stop ignoring node_modules');
    const { prepared } = await sendAndPrepare(fx, { commit: noIgnore });
    // Setup's own files are untracked and not ignored here, so they are on the provisioned list.
    expect(prepared.provisioned).toContain('node_modules');
    writeFile(prepared.jobFolder, 'node_modules/dep/extra.js', 'installed file');
    writeFile(prepared.jobFolder, 'src/a.txt', 'agent change\n');
    const result = await collected(noIgnore);
    if ('refused' in result) throw new Error(result.refused.message);
    expect(runGit(['diff', '--name-status', noIgnore, result.commit], bare())).toBe('M\tsrc/a.txt');
    expect(runGit(['ls-tree', '-r', '--name-only', result.commit], bare())).not.toMatch(/node_modules/);
    for (const provisioned of prepared.provisioned) {
      expect(runGit(['ls-tree', '-r', '--name-only', result.commit], bare()).split('\n')).not.toContain(provisioned);
    }
  });

  it('splits a larger pack into chunks of the agreed size that put back together into the pack', async () => {
    const { commit, prepared } = await sendAndPrepare(fx);
    writeFile(prepared.jobFolder, 'big.bin', randomBytes(700 * 1024));
    const result = await collected(commit);
    if ('refused' in result) throw new Error(result.refused.message);
    expect(result.packChunks).toBe(2);
    const first = Buffer.from((await fx.host.fetchPack({ packId: result.packId, index: 0 })).dataBase64, 'base64');
    expect(first.length).toBe(512 * 1024);
    await fetchInto(fx.mac, result.packId, result.packChunks);
    expect(runGit(['cat-file', '-s', `${result.commit}:big.bin`], fx.mac)).toBe(String(700 * 1024));
    await expect(fx.host.fetchPack({ packId: result.packId, index: 2 })).rejects.toThrow(/past the end/);
    await expect(fx.host.fetchPack({ packId: 'unknown-pack-id', index: 0 })).rejects.toThrow(/not kept/);
  });

  it('keeps one pack per job: an older one is deleted on the next collect, and an unchanged folder collects the same tree', async () => {
    const { commit, prepared } = await sendAndPrepare(fx);
    writeFile(prepared.jobFolder, 'src/a.txt', 'again\n');
    const one = await collected(commit);
    const two = await collected(commit);
    if ('refused' in one || 'refused' in two) throw new Error('refused');
    expect(runGit(['rev-parse', `${one.commit}^{tree}`], bare())).toBe(runGit(['rev-parse', `${two.commit}^{tree}`], bare()));
    expect(readdirSync(join(fx.root, 'queue-packs'))).toEqual([`${two.packId}.pack`]);
    await expect(fx.host.fetchPack({ packId: one.packId, index: 0 })).rejects.toThrow(/not kept/);
  });

  it('collects an untouched folder as a commit with no changes', async () => {
    const { commit } = await sendAndPrepare(fx);
    const result = await collected(commit);
    if ('refused' in result) throw new Error(result.refused.message);
    expect(runGit(['diff', '--name-status', commit, result.commit], bare())).toBe('');
    expect(result.documents).toEqual([]);
    expect(result.deleted).toEqual([]);
  });

  describe('refusals', () => {
    it('refuses while a session is in the folder, and leaves nothing behind', async () => {
      const { commit, prepared } = await sendAndPrepare(fx);
      writeFile(prepared.jobFolder, 'src/a.txt', 'work in progress\n');
      fx.folders.busy = true;
      expect(await collected(commit)).toMatchObject({ refused: { reason: 'session-running' } });
      expect(runGit(['for-each-ref', `refs/queue/${JOB}/collected`], bare())).toBe('');
      expect(existsSync(join(fx.root, 'queue-packs'))).toBe(false);
      fx.folders.busy = false;
      expect('refused' in await collected(commit)).toBe(false);
    });

    it('refuses a parent other than the last commit sent', async () => {
      const { commit } = await sendAndPrepare(fx);
      const result = await collected('a'.repeat(40));
      expect(result).toMatchObject({ refused: { reason: 'wrong-parent' } });
      expect(runGit(['for-each-ref', `refs/queue/${JOB}/collected`], bare())).toBe('');
      expect(commit).toMatch(/^[0-9a-f]{40}$/);
    });

    it('refuses when the agent made a commit itself, keeping its work', async () => {
      const { commit, prepared } = await sendAndPrepare(fx);
      writeFile(prepared.jobFolder, 'src/a.txt', 'committed by the agent\n');
      runGit(['add', '-A'], prepared.jobFolder);
      runGit(['commit', '-qm', 'agent commit', '--no-verify'], prepared.jobFolder);
      expect(await collected(commit)).toMatchObject({ refused: { reason: 'agent-committed' } });
      expect(runGit(['log', '-1', '--format=%s', `refs/heads/${BRANCH}`], bare())).toBe('agent commit');
      expect(runGit(['for-each-ref', `refs/queue/${JOB}/collected`], bare())).toBe('');
    });

    it('refuses when the agent moved the folder to another branch or a detached commit', async () => {
      const { commit, prepared } = await sendAndPrepare(fx);
      runGit(['checkout', '-q', '--detach'], prepared.jobFolder);
      expect(await collected(commit)).toMatchObject({ refused: { reason: 'agent-committed' } });
    });

    it('refuses a job that was never sent, and one whose folder is gone', async () => {
      expect(await collected('b'.repeat(40))).toMatchObject({ refused: { reason: 'no-copy' } });
      const { commit } = await sendAndPrepare(fx);
      await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH });
      // Remove clears the references too, so that is "no copy"; a copy without its folder is "not prepared".
      expect(await collected(commit)).toMatchObject({ refused: { reason: 'no-copy' } });
      const { commit: again, prepared } = await sendAndPrepare(fx, { jobId: 'job-two', branch: 'queue/job-two-def456' });
      rmSync(prepared.jobFolder, { recursive: true, force: true });
      expect(await collected(again, { jobId: 'job-two', branch: 'queue/job-two-def456' })).toMatchObject({ refused: { reason: 'not-prepared' } });
      const second = await sendAndPrepare(fx, { jobId: 'job-three', branch: 'queue/job-three-ghi789' });
      rmSync(second.prepared.planningFolder, { recursive: true, force: true });
      expect(await collected(second.commit, { jobId: 'job-three', branch: 'queue/job-three-ghi789' })).toMatchObject({ refused: { reason: 'not-prepared' } });
    });

    it('refuses a planning folder with a link that leads outside it, creating no commit', async () => {
      const { commit, prepared } = await sendAndPrepare(fx);
      const outside = join(fx.dir, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'secret.txt'), 'secret');
      symlinkSync(outside, join(prepared.planningFolder, 'sneaky'), 'junction');
      const result = await collected(commit);
      expect(result).toMatchObject({ refused: { reason: 'path-outside' } });
      expect(runGit(['for-each-ref', `refs/queue/${JOB}/collected`], bare())).toBe('');
      expect(existsSync(join(fx.root, 'queue-packs'))).toBe(false);
    });

    it('does not carry a link that stays inside the planning folder, and never follows one', async () => {
      const { commit, prepared } = await sendAndPrepare(fx, { docs: { 'a.md': 'one' } });
      symlinkSync(join(prepared.planningFolder, 'a.md'), join(prepared.planningFolder, 'alias.md'));
      const result = await collected(commit);
      if ('refused' in result) throw new Error(result.refused.message);
      expect(result.documents).toEqual([]);
    });
  });
});
