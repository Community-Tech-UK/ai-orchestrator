import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_PACK_CHUNK_BYTES } from '../../remote-node/queue-job-rpc-schemas';
import { collectAndApply, type CollectAndApplyResult } from './queue-job-copy-back';
import { FakeComputer, FakeMac } from './queue-job-fake-computer.test-helpers';
import { sendCommit } from './queue-job-send';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mac: FakeMac;
let far: FakeComputer;

beforeEach(() => {
  mac = new FakeMac({ 'README.md': 'hello\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n', 'run.sh': '#!/bin/sh\n' });
  far = new FakeComputer();
});
afterEach(() => { mac.dispose(); far.dispose(); });

/** Send the job's HEAD and make the far folder, as the coordinator does at the start of a turn. */
async function startTurn(turnId = 't1'): Promise<string> {
  const commit = mac.head();
  await sendCommit({ link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1', commit, baseBranch: 'main', startCommit: commit, lastExchanged: null });
  await far.prepare('node', { project: 'repo-1', jobId: 'job-1', branch: mac.branch, commit, documents: [], turnId });
  return commit;
}

function collect(expectedParent: string): Promise<CollectAndApplyResult> {
  return collectAndApply({
    link: far, nodeId: 'node', computerLabel: 'the Windows PC', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1',
    branch: mac.branch, jobFolder: mac.job, expectedParent,
  });
}

const status = (): string => mac.git(['status', '--porcelain', '--untracked-files=all'], mac.job);

function expectCollected(result: CollectAndApplyResult): Extract<CollectAndApplyResult, { commit: string }> {
  if ('refused' in result) throw new Error(`refused: ${result.refused.message}`);
  return result;
}

describe('collectAndApply', () => {
  it('turns the far changes into uncommitted changes: edits unstaged, new files untracked and not staged', async () => {
    const parent = await startTurn();
    far.agentWrite('job-1', 'src/a.txt', 'a changed\n');
    far.agentWrite('job-1', 'src/new.txt', 'new\n');
    far.agentWrite('job-1', 'deep/er/new.txt', 'deeper\n');
    const result = expectCollected(await collect(parent));
    expect(result.applied).toBe('applied');
    expect(result.changedFiles.sort()).toEqual(['deep/er/new.txt', 'src/a.txt', 'src/new.txt']);
    expect(mac.head()).toBe(parent);
    expect(status().split('\n').sort()).toEqual([' M src/a.txt', '?? deep/er/new.txt', '?? src/new.txt']);
    expect(mac.git(['diff', '--cached', '--name-only'], mac.job)).toBe('');
    expect(mac.read('src/a.txt')).toBe('a changed\n');
    // The collected commit is in this repository and follows the parent.
    expect(mac.git(['rev-parse', `${result.commit}^`])).toBe(parent);
  });

  it('applies deletions and renames', async () => {
    const parent = await startTurn();
    far.agentDelete('job-1', 'src/a.txt');
    far.agentWrite('job-1', 'src/c.txt', 'b\n');
    far.agentDelete('job-1', 'src/b.txt');
    expectCollected(await collect(parent));
    expect(existsSync(join(mac.job, 'src/a.txt'))).toBe(false);
    expect(existsSync(join(mac.job, 'src/b.txt'))).toBe(false);
    expect(mac.read('src/c.txt')).toBe('b\n');
    expect(status().split('\n').sort()).toEqual([' D src/a.txt', ' D src/b.txt', '?? src/c.txt']);
    // After the save the pair is a rename, as for a job that ran here.
    mac.save();
    expect(mac.git(['show', '--name-status', '--format=', '-M', 'HEAD'], mac.job)).toMatch(/R\d*\s+src\/b.txt\s+src\/c.txt/);
  });

  it('keeps file modes', async () => {
    const parent = await startTurn();
    chmodSync(join(far.jobFolder('job-1'), 'run.sh'), 0o755);
    writeFileSync(join(far.jobFolder('job-1'), 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 });
    chmodSync(join(far.jobFolder('job-1'), 'tool.sh'), 0o755);
    expectCollected(await collect(parent));
    expect(statSync(join(mac.job, 'run.sh')).mode & 0o111).not.toBe(0);
    expect(statSync(join(mac.job, 'tool.sh')).mode & 0o111).not.toBe(0);
    expect(status()).toContain(' M run.sh');
  });

  it('leaves files that exist only in this Mac folder alone', async () => {
    writeFileSync(join(mac.repo, '.git', 'info', 'exclude'), '.env.local\nlinked/\n', { flag: 'a' });
    const parent = await startTurn();
    mac.write('.env.local', 'LOCAL_SETTING=placeholder\n', mac.job);
    mkdirSync(join(mac.root, 'elsewhere'), { recursive: true });
    writeFileSync(join(mac.root, 'elsewhere', 'dep.txt'), 'dependency\n');
    symlinkSync(join(mac.root, 'elsewhere'), join(mac.job, 'linked'));
    mac.write('mine.txt', 'only here\n', mac.job);
    far.agentWrite('job-1', 'src/a.txt', 'far edit\n');
    expectCollected(await collect(parent));
    expect(mac.read('.env.local')).toBe('LOCAL_SETTING=placeholder\n');
    expect(readFileSync(join(mac.job, 'linked', 'dep.txt'), 'utf8')).toBe('dependency\n');
    expect(mac.read('mine.txt')).toBe('only here\n');
    expect(mac.read('src/a.txt')).toBe('far edit\n');
  });

  it('carries a large binary file through several fetches', async () => {
    const parent = await startTurn();
    const blob = randomBytes(QUEUE_PACK_CHUNK_BYTES * 2 + 77);
    far.agentWrite('job-1', 'assets/blob.bin', blob);
    const fetch = vi.spyOn(far, 'fetchPack');
    expectCollected(await collect(parent));
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(readFileSync(join(mac.job, 'assets/blob.bin')).equals(blob)).toBe(true);
    expect(status()).toBe('?? assets/blob.bin');
  });

  it('reports no change when the agent changed nothing', async () => {
    const parent = await startTurn();
    const result = expectCollected(await collect(parent));
    expect(result.applied).toBe('none');
    expect(result.changedFiles).toEqual([]);
    expect(status()).toBe('');
  });

  it('lists new planning files in the folder as left out, and returns the documents and deletions as sent', async () => {
    const parent = await startTurn();
    far.agentWrite('job-1', 'docs/plans/x_plan.md', '# plan\n');
    far.agentWrite('job-1', 'src/real.txt', 'x\n');
    far.agentWrite('job-1', 'notes_livetest.md', 'check\n');
    far.agentWritePlanning('job-1', 'docs/plans/y_plan.md', 'doc\n');
    const result = expectCollected(await collect(parent));
    expect(result.leftOut.sort()).toEqual(['docs/plans/x_plan.md', 'notes_livetest.md']);
    expect(result.documents.map(document => document.path)).toEqual(['docs/plans/y_plan.md']);
    expect(result.deleted).toEqual([]);
  });

  it('survives a merge of main made on this Mac between turns: the next copy-back applies only the far change', async () => {
    const first = await startTurn('t1');
    far.agentWrite('job-1', 'src/a.txt', 'a from far, round 1\n');
    expectCollected(await collect(first));
    const saved = mac.save('round 1 work');
    // Meanwhile main moves, and the queue merges it into the job here.
    mac.write('src/b.txt', 'b from main\n');
    mac.git(['add', '-A']);
    mac.git(['commit', '-q', '-m', 'main moves']);
    mac.git(['merge', '-q', '--no-edit', 'main'], mac.job);
    const merged = mac.head();
    expect(merged).not.toBe(saved);
    // The next turn starts from the merged commit; the far folder moves to it.
    await sendCommit({ link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1', commit: merged, baseBranch: 'main', startCommit: first, lastExchanged: saved });
    await far.prepare('node', { project: 'repo-1', jobId: 'job-1', branch: mac.branch, commit: merged, documents: [], turnId: 't2' });
    expect(readFileSync(join(far.jobFolder('job-1'), 'src/b.txt'), 'utf8')).toBe('b from main\n');
    far.agentWrite('job-1', 'src/c.txt', 'c from far, round 2\n');
    const result = expectCollected(await collect(merged));
    expect(result.changedFiles).toEqual(['src/c.txt']);
    expect(mac.read('src/b.txt')).toBe('b from main\n');
    expect(mac.read('src/a.txt')).toBe('a from far, round 1\n');
    expect(mac.read('src/c.txt')).toBe('c from far, round 2\n');
    expect(mac.head()).toBe(merged);
    expect(status()).toBe('?? src/c.txt');
  });

  describe('refusals leave everything as it was', () => {
    it.each([
      ['session-running', () => { far.sessionRunning = true; }],
      ['agent-committed', () => { far.agentWrite('job-1', 'src/a.txt', 'x\n'); far.agentGit('job-1', 'commit', '-q', '-am', 'by the agent'); }],
    ] as const)('returns the computer\'s refusal %s unchanged', async (reason, arrange) => {
      const parent = await startTurn();
      arrange();
      const result = await collect(parent);
      expect(result).toEqual({ refused: { reason, message: expect.any(String) } });
      expect(mac.head()).toBe(parent);
      expect(status()).toBe('');
    });

    it('returns wrong-parent when the computer holds a different commit than this Mac expects', async () => {
      await startTurn();
      const other = mac.save('a commit the computer never saw');
      const result = await collect(other);
      expect(result).toMatchObject({ refused: { reason: 'wrong-parent' } });
      expect(status()).toBe('');
    });

    it('refuses when the folder has moved, and never asks the computer', async () => {
      const parent = await startTurn();
      mac.save('moved on here');
      const result = await collect(parent);
      expect(result).toMatchObject({ refused: { reason: 'folder-moved' } });
      expect(far.calls).not.toContain('collect');
    });

    it('refuses a collected commit that does not follow the last one', async () => {
      const parent = await startTurn();
      far.collectOverride = () => ({ commit: parent, packId: 'aaaaaaaa', packChunks: 0, documents: [], deleted: [] });
      const result = await collect(parent);
      expect(result).toMatchObject({ refused: { reason: 'wrong-commit' } });
      expect(status()).toBe('');
    });

    it('refuses a change that does not fit the folder, touching nothing, not even the files that would have fit', async () => {
      const parent = await startTurn();
      far.agentWrite('job-1', 'src/a.txt', 'far a\n');
      far.agentWrite('job-1', 'src/fits.txt', 'would fit\n');
      mac.write('src/a.txt', 'local a\n', mac.job);
      const result = await collect(parent);
      expect(result).toMatchObject({ refused: { reason: 'apply-failed' } });
      expect((result as { refused: { message: string } }).refused.message).toMatch(/nothing was copied back/);
      expect(mac.read('src/a.txt')).toBe('local a\n');
      expect(existsSync(join(mac.job, 'src/fits.txt'))).toBe(false);
      expect(status()).toBe(' M src/a.txt');
    });

    it('refuses a new file that already exists in the folder as a local file', async () => {
      const parent = await startTurn();
      far.agentWrite('job-1', 'settings.local', 'far\n');
      far.agentWrite('job-1', 'src/a.txt', 'far a\n');
      mac.write('settings.local', 'mine\n', mac.job);
      expect(await collect(parent)).toMatchObject({ refused: { reason: 'apply-failed' } });
      expect(mac.read('settings.local')).toBe('mine\n');
      expect(mac.read('src/a.txt')).toBe('a\n');
    });
  });

  it('treats a second copy-back of the same turn as already applied and changes nothing more', async () => {
    const parent = await startTurn();
    far.agentWrite('job-1', 'src/a.txt', 'far a\n');
    far.agentWrite('job-1', 'src/new.txt', 'new\n');
    expectCollected(await collect(parent));
    const before = status();
    const again = expectCollected(await collect(parent));
    expect(again.applied).toBe('already-applied');
    expect(status()).toBe(before);
    expect(mac.read('src/a.txt')).toBe('far a\n');
  });
});
