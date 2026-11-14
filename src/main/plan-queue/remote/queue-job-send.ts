/**
 * Out: send a job's commit to another computer as a thin git pack (spec: "Out: the job's code reaches the other
 * computer"). Only the objects that computer lacks travel: it is asked which of a short list of commits it already
 * has (the base branch's tip and recent history, the job's last-exchanged commit, its start commit) and the pack is
 * made against those, as `scripts/remote-checks/run-remote.js` does for test runs.
 *
 * The pack is written to a temporary file first because every `queue.receive` call carries the chunk count, so the
 * whole size must be known before the first one goes. Each send uses a fresh upload id: a dropped connection
 * leaves the worker with a partial upload under the old id, which it never reuses, so sending again is always safe.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { QUEUE_PACK_CHUNK_BYTES } from '../../remote-node/queue-job-rpc-schemas';
import { QueueJobLinkError, type QueueJobLink } from './queue-job-link';
import { QueueJobGitError, gitText, hasCommit, runGit } from './queue-job-git';

/** Commits offered to the computer as "do you have this?": the base branch's recent history, plus two more. */
export const MAX_HISTORY_CANDIDATES = 300;

export interface SendCommitArgs {
  link: QueueJobLink;
  nodeId: string;
  /** This Mac's repository: the job's folder shares its object store. */
  repoRoot: string;
  /** The project's name on the computer (`queueProjectKeyFor`). */
  project: string;
  jobId: string;
  /** The commit to send. */
  commit: string;
  /** The base branch's name here; its tip goes too, for the agent's comparisons. */
  baseBranch: string;
  /** The commit the job started from. */
  startCommit: string;
  /** The last commit exchanged for this job, or null. */
  lastExchanged: string | null;
}

export interface SendCommitResult {
  commit: string;
  /** The base branch's tip that was sent, or null when the branch is not in this repository. */
  baseTip: string | null;
  /** Bytes of pack sent; 0 when the computer already had every object. */
  packBytes: number;
  chunks: number;
  /** How many of the offered commits the computer already had. */
  alreadyThere: number;
}

const SHA = /^[0-9a-f]{40}$/;

async function resolveCommit(repoRoot: string, name: string): Promise<string | null> {
  if (name.startsWith('-')) throw new Error(`"${name}" is not a branch name`);
  try { return await gitText(['rev-parse', '--verify', '--quiet', `${name}^{commit}`], repoRoot); }
  catch (error) { if (error instanceof QueueJobGitError) return null; throw error; }
}

/** The commits worth asking about, newest first, only those this repository really has. */
async function haveCandidates(args: SendCommitArgs, baseTip: string | null): Promise<string[]> {
  const found = new Set<string>();
  if (baseTip) {
    const history = await gitText(['rev-list', `--max-count=${MAX_HISTORY_CANDIDATES}`, baseTip], args.repoRoot);
    for (const line of history.split('\n')) if (SHA.test(line)) found.add(line);
  }
  for (const extra of [args.lastExchanged, args.startCommit]) {
    if (extra && SHA.test(extra) && !found.has(extra) && await hasCommit(args.repoRoot, extra)) found.add(extra);
  }
  return [...found];
}

/** A pack with no objects: git still writes the 12-byte header (object count at bytes 8 to 12) and a checksum. */
async function packIsEmpty(file: fs.FileHandle, size: number): Promise<boolean> {
  if (size === 0) return true;
  const header = Buffer.alloc(12);
  const { bytesRead } = await file.read(header, 0, 12, 0);
  return bytesRead === 12 && header.readUInt32BE(8) === 0;
}

export async function sendCommit(args: SendCommitArgs): Promise<SendCommitResult> {
  const { link, nodeId, repoRoot, project, jobId, commit } = args;
  if (!SHA.test(commit) || !(await hasCommit(repoRoot, commit))) throw new Error(`Cannot send ${commit}: it is not a commit in this repository.`);
  const baseTip = await resolveCommit(repoRoot, args.baseBranch);
  const candidates = await haveCandidates(args, baseTip);
  const have = candidates.length ? new Set((await link.have(nodeId, { project, candidates })).have) : new Set<string>();
  // Only what we offered, and only what this repository has: anything else cannot be a pack boundary.
  const bases = candidates.filter(candidate => have.has(candidate));

  const wants = [...new Set([commit, baseTip, args.startCommit].filter((sha): sha is string => !!sha && SHA.test(sha)))];
  const wanted = [];
  for (const sha of wants) if (await hasCommit(repoRoot, sha)) wanted.push(sha);
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-queue-pack-'));
  try {
    const packFile = path.join(folder, 'send.pack');
    const handle = await fs.open(packFile, 'w+');
    try {
      await runGit(['pack-objects', '--revs', '--thin', '--stdout', '--quiet'], repoRoot, {
        input: `${wanted.join('\n')}\n${bases.map(base => `^${base}\n`).join('')}`,
        stdoutTo: handle,
        timeoutMs: 10 * 60_000,
      });
      const size = (await handle.stat()).size;
      const empty = await packIsEmpty(handle, size);
      const total = empty ? 1 : Math.ceil(size / QUEUE_PACK_CHUNK_BYTES);
      const uploadId = randomUUID();
      const final = { commit, baseTip, startCommit: args.startCommit };
      const buffer = Buffer.alloc(QUEUE_PACK_CHUNK_BYTES);
      for (let index = 0; index < total; index += 1) {
        let dataBase64 = '';
        if (!empty) {
          const { bytesRead } = await handle.read(buffer, 0, QUEUE_PACK_CHUNK_BYTES, index * QUEUE_PACK_CHUNK_BYTES);
          dataBase64 = buffer.subarray(0, bytesRead).toString('base64');
        }
        const last = index === total - 1;
        const result = await link.receive(nodeId, {
          project, jobId, uploadId, index, total, dataBase64, ...(last ? { final } : {}),
        });
        if (last && !result.complete) throw new QueueJobLinkError('failed', 'The computer received the code but did not accept it.');
      }
      return { commit, baseTip, packBytes: empty ? 0 : size, chunks: total, alreadyThere: bases.length };
    } finally {
      await handle.close();
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}
