import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRANCH, JOB, PROJECT, commitAll, makeChunks, makeFixture, runGit, sendCommit, uploadChunks, writeFile, type Fixture } from './queue-job-fixture.test-helpers';

let fx: Fixture;
const bare = (): string => join(fx.root, 'queue-repos', `${PROJECT}.git`);
const ref = (name: string): string => runGit(['rev-parse', '--verify', '--quiet', name], bare());
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());

describe('queue.have and queue.receive', () => {
  it('has nothing before the first send, then reports exactly the commits it holds', async () => {
    const first = runGit(['rev-parse', 'HEAD'], fx.mac);
    expect(await fx.host.have({ project: PROJECT, candidates: [first] })).toEqual({ have: [] });
    await sendCommit(fx, { commit: first });
    writeFile(fx.mac, 'src/a.txt', 'changed\n');
    const second = commitAll(fx.mac, 'second');
    expect(await fx.host.have({ project: PROJECT, candidates: [first, second, 'a'.repeat(40)] })).toEqual({ have: [first] });
  });

  it('stores a chunked pack in a bare repository with the three job references and the required settings', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    writeFile(fx.mac, 'big.bin', randomBytes(6000));
    const next = commitAll(fx.mac, 'with a larger file');
    const sent = await sendCommit(fx, { commit: next, baseTip: commit, startCommit: commit, chunkBytes: 700 });
    expect(sent.total).toBeGreaterThan(2);
    expect(ref(`refs/queue/${JOB}/sent`)).toBe(next);
    expect(ref(`refs/queue/${JOB}/base`)).toBe(commit);
    expect(ref(`refs/queue/${JOB}/start`)).toBe(commit);
    expect(runGit(['config', 'core.autocrlf'], bare())).toBe('false');
    expect(runGit(['config', 'core.longpaths'], bare())).toBe('true');
    expect(runGit(['config', 'gc.auto'], bare())).toBe('0');
    expect(runGit(['remote'], bare())).toBe('');
    expect(runGit(['cat-file', '-p', `${next}:big.bin`], bare()).length).toBeGreaterThan(0);
    expect(existsSync(join(fx.root, 'queue-uploads', sent.uploadId))).toBe(false); // cleaned up
  });

  it('sends only what is new when the far side already holds the earlier commit, and never moves the start reference', async () => {
    const first = runGit(['rev-parse', 'HEAD'], fx.mac);
    await sendCommit(fx, { commit: first });
    writeFile(fx.mac, 'src/a.txt', 'changed\n');
    const second = commitAll(fx.mac, 'second');
    await sendCommit(fx, { commit: second, have: [first], baseTip: first, startCommit: second });
    expect(ref(`refs/queue/${JOB}/sent`)).toBe(second);
    expect(ref(`refs/queue/${JOB}/start`)).toBe(first); // written once
    expect(ref(`refs/queue/${JOB}/base`)).toBe(first);
    await sendCommit(fx, { commit: second, have: [second], baseTip: null }); // empty pack: the commit is already there
    expect(() => ref(`refs/queue/${JOB}/base`)).toThrow(); // a null base tip clears the reference
  });

  it('does not store a partial upload, and finishes once the missing chunk arrives', async () => {
    writeFile(fx.mac, 'big.bin', randomBytes(4000));
    const commit = commitAll(fx.mac, 'big');
    const chunks = makeChunks(fx, commit, [], 600);
    expect(chunks.length).toBeGreaterThan(3);
    const uploadId = 'upload-partial-1';
    const last = chunks.length - 1;
    // Everything but chunk 1 arrives, the last chunk included: the call that carries `final` is refused.
    await expect(uploadChunks(fx, chunks, { commit, uploadId, only: [0, ...chunks.map((_, i) => i).filter(i => i > 1)] })).rejects.toThrow(/Chunk 2 of \d+ .* has not arrived/);
    expect(existsSync(bare()) && runGit(['for-each-ref', 'refs/queue'], bare())).toBeFalsy();
    expect(existsSync(join(fx.root, 'queue-uploads', uploadId))).toBe(true); // kept, so the gap can be filled
    await uploadChunks(fx, chunks, { commit, uploadId, only: [1, last] });
    expect(ref(`refs/queue/${JOB}/sent`)).toBe(commit);
  });

  it('refuses a commit that is not in the unpacked pack, and stores no reference', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    await expect(fx.host.receive({
      project: PROJECT, jobId: JOB, uploadId: 'upload-empty-1', index: 0, total: 1, dataBase64: '',
      final: { commit, baseTip: null, startCommit: commit },
    })).rejects.toThrow(/does not have the commit/);
    expect(runGit(['for-each-ref', 'refs/queue'], bare())).toBe('');
    expect(readdirSync(join(fx.root, 'queue-uploads'))).toEqual([]);
  });

  it('refuses a damaged pack and cleans the upload up', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    await expect(fx.host.receive({
      project: PROJECT, jobId: JOB, uploadId: 'upload-bad-pack', index: 0, total: 1,
      dataBase64: Buffer.from('not a pack at all').toString('base64'), final: { commit, baseTip: null, startCommit: commit },
    })).rejects.toThrow(/git index-pack failed/);
    expect(readdirSync(join(fx.root, 'queue-uploads'))).toEqual([]);
  });

  it('refuses invalid base64, an upload id reused for another job, and a chunk over the size bound', async () => {
    await expect(fx.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-b64-0001', index: 0, total: 2, dataBase64: '@@@@' })).rejects.toThrow(/base64/);
    await fx.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-reuse-001', index: 0, total: 2, dataBase64: 'AAAA' });
    await expect(fx.host.receive({ project: PROJECT, jobId: 'other-job', uploadId: 'upload-reuse-001', index: 1, total: 2, dataBase64: 'AAAA' })).rejects.toThrow(/different job/);
    const small = makeFixture({ limits: { maxUploadBytes: 4 } });
    try {
      await expect(small.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-big-0001', index: 0, total: 2, dataBase64: Buffer.alloc(10).toString('base64') })).rejects.toThrow(/larger than this computer accepts/);
      expect(readdirSync(join(small.root, 'queue-uploads'))).toEqual([]);
    } finally { small.dispose(); }
  });

  it('deletes an abandoned upload on a later call, and keeps a recent one', async () => {
    await fx.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-stale-001', index: 0, total: 2, dataBase64: 'AAAA' });
    const old = join(fx.root, 'queue-uploads', 'upload-stale-001');
    expect(existsSync(old)).toBe(true);
    let now = Date.now();
    const clocked = makeFixture({ now: () => now, limits: { uploadMaxAgeMs: 60_000 } });
    try {
      await clocked.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-clock-001', index: 0, total: 2, dataBase64: 'AAAA' });
      await clocked.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-clock-002', index: 0, total: 2, dataBase64: 'AAAA' });
      now += 10 * 60_000;
      const later = new Date(now);
      utimesSync(join(clocked.root, 'queue-uploads', 'upload-clock-002'), later, later);
      await clocked.host.receive({ project: PROJECT, jobId: JOB, uploadId: 'upload-clock-002', index: 1, total: 2, dataBase64: 'AAAA' });
      expect(readdirSync(join(clocked.root, 'queue-uploads'))).toEqual(['upload-clock-002']);
    } finally { clocked.dispose(); }
  });

  it('keeps the branch name out of the way: references are per job', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    await sendCommit(fx, { commit, jobId: 'job-a' });
    await sendCommit(fx, { commit, jobId: 'job-b' });
    expect(runGit(['for-each-ref', '--format=%(refname)', 'refs/queue'], bare()).split('\n').sort()).toEqual([
      'refs/queue/job-a/sent', 'refs/queue/job-a/start', 'refs/queue/job-b/sent', 'refs/queue/job-b/start',
    ]);
    expect(BRANCH).toMatch(/^queue\//);
  });
});
