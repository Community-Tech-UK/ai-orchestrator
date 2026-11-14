/**
 * Back: take a job's changes from the other computer and make this Mac's job folder match them as UNCOMMITTED
 * changes (spec: "Back: each checkpoint copies the files here, then saves them here").
 *
 * The folder's own commit never moves. The change between the last commit exchanged and the collected commit is
 * applied with `git apply` (not staged), so additions are untracked files, deletions and renames happen, file modes
 * survive, and files that exist only in this folder (its links and local settings) are left alone. The existing
 * `checkpoint` then runs on the folder exactly as it does for a job that ran here.
 *
 * Nothing is changed unless everything can be: a refusal from the computer, a folder that has moved, a collected
 * commit that does not follow the last one, or a change that does not fit the folder all return `refused`, and the
 * folder is as it was (`git apply --check` runs first and `git apply` itself is all-or-nothing).
 */
import * as fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { QueueDocument, QueueRefusalReason } from '../../remote-node/queue-job-rpc-schemas';
import { isActivePlanDocumentPath } from '../../workspace/git/active-plan-pattern';
import type { QueueJobLink } from './queue-job-link';
import { QueueJobGitError, gitText, hasCommit, runGit } from './queue-job-git';

export type CopyBackRefusalReason = QueueRefusalReason | 'folder-moved' | 'wrong-commit' | 'apply-failed';

export interface CollectAndApplyArgs {
  link: QueueJobLink;
  nodeId: string;
  /** What the job's computer is called in messages ("the Windows PC"). */
  computerLabel: string;
  /** This Mac's repository (the job's folder shares its object store). */
  repoRoot: string;
  project: string;
  jobId: string;
  branch: string;
  /** The job's folder on this Mac. Its HEAD must be `expectedParent`. */
  jobFolder: string;
  /** The last commit exchanged for the job. */
  expectedParent: string;
}

export type CollectAndApplyResult =
  | { refused: { reason: CopyBackRefusalReason; message: string } }
  | {
    /** The collected commit, now in this repository's object store (not on any branch). */
    commit: string;
    /** `already-applied`: an earlier try changed the folder and the save then failed; the folder already matches. */
    applied: 'none' | 'applied' | 'already-applied';
    /** Every path the change touches, as the far side recorded it. */
    changedFiles: string[];
    /** New planning files in the folder now: `checkpoint` moves them to the main checkout and leaves them out of the commit. */
    leftOut: string[];
    /** Returned as the worker sent them; writing them is `applyReturnedDocuments`. */
    documents: QueueDocument[];
    /** Sent planning documents that are gone on the far side. */
    deleted: string[];
  };

function refuse(reason: CopyBackRefusalReason, message: string): { refused: { reason: CopyBackRefusalReason; message: string } } {
  return { refused: { reason, message } };
}

/** Paths from `git diff --name-status -z`: status, then one path (renames are switched off). */
function parseNameStatus(raw: string): { status: string; file: string }[] {
  const parts = raw.split('\0').filter(Boolean);
  const entries: { status: string; file: string }[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) entries.push({ status: parts[i], file: parts[i + 1] });
  return entries;
}

async function downloadPack(args: CollectAndApplyArgs, packId: string, chunks: number, target: string): Promise<void> {
  const out = createWriteStream(target, { flags: 'wx' });
  const closed = new Promise<void>((resolve, reject) => { out.on('close', resolve); out.on('error', reject); });
  try {
    for (let index = 0; index < chunks; index += 1) {
      const { dataBase64 } = await args.link.fetchPack(args.nodeId, { packId, index });
      if (!out.write(Buffer.from(dataBase64, 'base64'))) await new Promise<void>(resolve => out.once('drain', resolve));
    }
  } finally {
    out.end();
    await closed;
  }
}

export async function collectAndApply(args: CollectAndApplyArgs): Promise<CollectAndApplyResult> {
  const { link, nodeId, repoRoot, jobFolder, expectedParent } = args;
  const there = args.computerLabel;
  const head = await gitText(['rev-parse', 'HEAD'], jobFolder);
  if (head !== expectedParent) {
    return refuse('folder-moved', `The job's folder on this Mac has moved since its code was last sent to ${there}, so ${there}'s changes were not copied back. They are kept on ${there}.`);
  }
  const collected = await link.collect(nodeId, {
    project: args.project, jobId: args.jobId, branch: args.branch, expectedParent,
  });
  if ('refused' in collected) return refuse(collected.refused.reason, collected.refused.message);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-queue-back-'));
  try {
    if (collected.packChunks > 0) {
      const packFile = path.join(scratch, 'back.pack');
      await downloadPack(args, collected.packId, collected.packChunks, packFile);
      await runGit(['index-pack', '--stdin', '--fix-thin'], repoRoot, { stdinFrom: createReadStream(packFile), timeoutMs: 10 * 60_000 });
    }
    if (!(await hasCommit(repoRoot, collected.commit))) {
      return refuse('wrong-commit', `${there} sent changes that Harness could not unpack, so nothing was copied back.`);
    }
    const parents = (await gitText(['rev-list', '--parents', '--max-count=1', collected.commit], repoRoot)).split(' ').slice(1);
    if (parents.length !== 1 || parents[0] !== expectedParent) {
      return refuse('wrong-commit', `${there}'s changes do not follow the code that was last sent there, so nothing was copied back.`);
    }

    const range = ['--no-renames', '--no-ext-diff', '--no-textconv', expectedParent, collected.commit];
    const entries = parseNameStatus((await runGit(['diff', '--name-status', '-z', ...range], repoRoot)).toString('utf8'));
    if (entries.some(({ file }) => file.split('/').includes('.git'))) {
      return refuse('path-outside', `${there}'s changes touch git's own folder, so nothing was copied back.`);
    }
    const changedFiles = entries.map(entry => entry.file);
    const leftOut = entries.filter(entry => entry.status === 'A' && isActivePlanDocumentPath(entry.file)).map(entry => entry.file);
    const result = { commit: collected.commit, changedFiles, leftOut, documents: collected.documents, deleted: collected.deleted };
    if (!entries.length) return { ...result, applied: 'none' as const };

    const patch = path.join(scratch, 'back.patch');
    const handle = await fs.open(patch, 'w');
    try { await runGit(['diff', '--binary', '--full-index', ...range], repoRoot, { stdoutTo: handle, timeoutMs: 5 * 60_000 }); }
    finally { await handle.close(); }

    // The folder could have moved while the pack came down; the check and the write both need it where it was.
    if ((await gitText(['rev-parse', 'HEAD'], jobFolder)) !== expectedParent) {
      return refuse('folder-moved', `The job's folder on this Mac moved while ${there}'s changes were coming back, so nothing was copied.`);
    }
    const applyOptions = ['apply', '--binary', '--whitespace=nowarn'];
    try {
      await runGit([...applyOptions, '--check', patch], jobFolder);
    } catch (error) {
      if (!(error instanceof QueueJobGitError)) throw error;
      // An earlier try may have applied it and then failed at the save: then the change is already in the folder.
      const already = await runGit([...applyOptions, '--check', '--reverse', patch], jobFolder).then(() => true, () => false);
      if (already) return { ...result, applied: 'already-applied' as const };
      return refuse('apply-failed', `${there}'s changes do not fit the job's folder on this Mac, so nothing was copied back (${firstLine(error.stderr)}).`);
    }
    try {
      await runGit([...applyOptions, patch], jobFolder);
    } catch (error) {
      if (!(error instanceof QueueJobGitError)) throw error;
      return refuse('apply-failed', `${there}'s changes could not be written into the job's folder on this Mac (${firstLine(error.stderr)}).`);
    }
    return { ...result, applied: 'applied' as const };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.replace(/^error:\s*/, '').slice(0, 300) || 'git gave no reason';
}
