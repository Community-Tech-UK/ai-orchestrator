import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_PACK_CHUNK_BYTES } from '../../remote-node/queue-job-rpc-schemas';
import { FakeComputer, FakeMac } from './queue-job-fake-computer.test-helpers';
import { QueueJobLinkError } from './queue-job-link';
import { MAX_HISTORY_CANDIDATES, sendCommit } from './queue-job-send';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let mac: FakeMac;
let far: FakeComputer;

beforeEach(() => {
  // Incompressible content, so the first pack is more than two chunks long.
  mac = new FakeMac({ 'README.md': 'hello\n', 'big.bin': randomBytes(QUEUE_PACK_CHUNK_BYTES * 2 + 1234) });
  far = new FakeComputer();
});
afterEach(() => { mac.dispose(); far.dispose(); });

function send(commit: string, lastExchanged: string | null = null, jobId = 'job-1') {
  return sendCommit({
    link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId, commit, baseBranch: 'main',
    startCommit: mac.head(mac.repo), lastExchanged,
  });
}

describe('sendCommit', () => {
  it('sends a first commit in chunks with the final details on the last chunk only', async () => {
    const commit = mac.head();
    const result = await send(commit);
    expect(far.hasCommit(commit)).toBe(true);
    expect(far.sentFor('job-1')).toEqual({ commit, baseTip: commit, startCommit: commit });
    expect(result.chunks).toBe(far.receives.length);
    expect(result.chunks).toBeGreaterThanOrEqual(3);
    expect(far.receives.map(receive => receive.index)).toEqual([...far.receives.keys()]);
    expect(far.receives.every(receive => receive.total === result.chunks)).toBe(true);
    expect(far.receives.map(receive => receive.final)).toEqual(far.receives.map((_, index) => index === far.receives.length - 1));
    expect(new Set(far.receives.map(receive => receive.uploadId)).size).toBe(1);
  });

  it('cuts the pack at exactly the chunk size and loses no byte', async () => {
    const result = await send(mac.head());
    const sizes = far.receives.map(receive => receive.bytes);
    expect(sizes.slice(0, -1).every(size => size === QUEUE_PACK_CHUNK_BYTES)).toBe(true);
    expect(sizes[sizes.length - 1]).toBeGreaterThan(0);
    expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(QUEUE_PACK_CHUNK_BYTES);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(result.packBytes);
  });

  it('sends only the new objects for a child commit', async () => {
    const firstCommit = mac.head();
    const first = await send(firstCommit);
    mac.write('notes.txt', 'one small file\n', mac.job);
    const child = mac.save('child');
    const received = far.receives.length;
    const second = await send(child, firstCommit);
    expect(far.hasCommit(child)).toBe(true);
    expect(second.alreadyThere).toBeGreaterThan(0);
    expect(second.chunks).toBe(1);
    expect(far.receives.length).toBe(received + 1);
    expect(second.packBytes).toBeLessThan(2_000);
    expect(first.packBytes).toBeGreaterThan(QUEUE_PACK_CHUNK_BYTES * 2);
  });

  it('sends one empty chunk when the computer already has the commit', async () => {
    const commit = mac.head();
    await send(commit);
    far.receives.length = 0;
    const again = await send(commit, commit);
    expect(again.packBytes).toBe(0);
    expect(far.receives).toHaveLength(1);
    expect(far.receives[0]).toMatchObject({ index: 0, total: 1, bytes: 0, final: true });
    expect(far.sentFor('job-1')?.commit).toBe(commit);
  });

  it('sends again safely after a dropped connection, under a new upload id', async () => {
    far.dropReceiveAt = 2;
    await expect(send(mac.head())).rejects.toBeInstanceOf(QueueJobLinkError);
    expect(far.sentFor('job-1')).toBeUndefined();
    far.dropReceiveAt = null;
    const retry = await send(mac.head());
    expect(far.hasCommit(mac.head())).toBe(true);
    expect(retry.chunks).toBeGreaterThanOrEqual(3);
    const ids = [...new Set(far.receives.map(receive => receive.uploadId))];
    expect(ids).toHaveLength(2);
  });

  it('carries the base branch tip when main has moved past the job', async () => {
    const jobCommit = mac.head();
    mac.write('later.txt', 'moved on\n');
    mac.git(['add', '-A']);
    mac.git(['commit', '-q', '-m', 'main moves']);
    const mainTip = mac.head(mac.repo);
    await sendCommit({ link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1', commit: jobCommit, baseBranch: 'main', startCommit: jobCommit, lastExchanged: null });
    expect(far.hasCommit(mainTip)).toBe(true);
    expect(far.sentFor('job-1')?.baseTip).toBe(mainTip);
  });

  it('sends null for the base tip when the branch is not in the repository, and keeps the candidate list bounded', async () => {
    const have = vi.spyOn(far, 'have');
    const commit = mac.head();
    for (let i = 0; i < 5; i += 1) { mac.write(`f${i}.txt`, `${i}\n`); mac.git(['add', '-A']); mac.git(['commit', '-q', '-m', `m${i}`]); }
    await sendCommit({ link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1', commit, baseBranch: 'no-such-branch', startCommit: commit, lastExchanged: null });
    expect(far.sentFor('job-1')?.baseTip).toBeNull();
    expect(have).toHaveBeenCalledTimes(1);
    expect(have.mock.calls[0][1].candidates.length).toBeLessThanOrEqual(MAX_HISTORY_CANDIDATES + 2);
  });

  it('refuses a commit that this repository does not have', async () => {
    await expect(send('0123456789abcdef0123456789abcdef01234567')).rejects.toThrow(/not a commit in this repository/);
    expect(far.calls).toEqual([]);
  });

  it('does not take a branch name that looks like an option', async () => {
    await expect(sendCommit({ link: far, nodeId: 'node', repoRoot: mac.repo, project: 'repo-1', jobId: 'job-1', commit: mac.head(), baseBranch: '--all', startCommit: mac.head(), lastExchanged: null }))
      .rejects.toThrow(/not a branch name/);
  });
});
