/**
 * Specs for the worker's `queue.*` calls: a "Mac" repository and a real `QueueJobHost` rooted in a temporary
 * folder, with the Mac's side done by real git (thin packs and all). The installer is a fake, so no `npm` runs.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { vi } from 'vitest';
import { QUEUE_PACK_CHUNK_BYTES, type QueueDocument } from '../../main/remote-node/queue-job-rpc-schemas';
import type { QueueInstaller, QueueJobFolderControl, QueueJobFolders } from './queue-job-env';
import { QueueJobHost, type QueueJobHostOptions } from './queue-job-host';
import { stripScopedGitEnv } from '../../main/workspace/git/git-env';

const IDENTITY = { GIT_AUTHOR_NAME: 'Mac', GIT_AUTHOR_EMAIL: 'mac@example.invalid', GIT_COMMITTER_NAME: 'Mac', GIT_COMMITTER_EMAIL: 'mac@example.invalid' };

export function runGit(args: string[], cwd: string, input?: Buffer | string): string {
  const env = { ...stripScopedGitEnv({ ...process.env }), ...IDENTITY };
  return execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** The same instance manager surface the host needs, with a switch for "a session is running". */
export class FakeFolders implements QueueJobFolderControl {
  readonly registered = new Map<string, QueueJobFolders>();
  busy = false;
  registerQueueJobFolders(folders: QueueJobFolders): void { this.registered.set(folders.jobFolder, folders); }
  unregisterQueueJobFolders(jobFolder: string): void { this.registered.delete(jobFolder); }
  hasInstanceInFolders(): boolean { return this.busy; }
}

export const PROJECT = 'proj-12345678';
export const BRANCH = 'queue/job-one-abc123';
export const JOB = 'job-one';

export interface Fixture {
  dir: string;
  root: string;
  mac: string;
  host: QueueJobHost;
  folders: FakeFolders;
  install: ReturnType<typeof vi.fn<QueueInstaller>>;
  dispose(): void;
}

export function fakeInstaller(): ReturnType<typeof vi.fn<QueueInstaller>> {
  return vi.fn<QueueInstaller>(async installedPath => {
    mkdirSync(join(installedPath, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(installedPath, 'node_modules', 'dep', 'index.js'), 'module.exports = 1;');
  });
}

export function makeFixture(options: Partial<QueueJobHostOptions> = {}): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aio-queue-host-')));
  const mac = join(dir, 'mac');
  const root = join(dir, 'root');
  mkdirSync(mac);
  mkdirSync(root);
  runGit(['init', '-q', '-b', 'main'], mac);
  runGit(['config', 'core.autocrlf', 'false'], mac);
  writeFile(mac, 'package.json', JSON.stringify({ name: 'proj', version: '1.0.0', scripts: { check: 'node -e 0' } }));
  writeFile(mac, 'package-lock.json', '{"lock":1}');
  writeFile(mac, '.gitignore', 'node_modules\n');
  writeFile(mac, '.worktreeinclude', 'node_modules\n');
  writeFile(mac, 'src/a.txt', 'one\n');
  writeFile(mac, 'src/b.txt', 'two\n');
  runGit(['add', '-A'], mac);
  runGit(['commit', '-qm', 'start'], mac);
  const folders = new FakeFolders();
  const install = fakeInstaller();
  const host = new QueueJobHost({ root, folders, install, ...options });
  return { dir, root, mac, host, folders, install, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeFile(base: string, relative: string, content: string | Buffer): void {
  const target = join(base, ...relative.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

export function commitAll(repo: string, message: string): string {
  runGit(['add', '-A'], repo);
  runGit(['commit', '-qm', message], repo);
  return runGit(['rev-parse', 'HEAD'], repo);
}

export interface SendOptions {
  jobId?: string;
  project?: string;
  commit: string;
  /** Commits the far computer already has: left out of the thin pack. */
  have?: string[];
  baseTip?: string | null;
  startCommit?: string;
  chunkBytes?: number;
  uploadId?: string;
  /** Send only these chunk indexes (to leave an upload partial). */
  only?: number[];
}

let uploadCounter = 0;

/** A thin pack of `commit` against `have`, split into chunks. */
export function makeChunks(fixture: Fixture, commit: string, have: string[] = [], chunkBytes = QUEUE_PACK_CHUNK_BYTES): Buffer[] {
  const input = `${commit}\n${have.map(sha => `^${sha}`).join('\n')}\n`;
  const pack = Buffer.from(execFileSync('git', ['pack-objects', '--thin', '--revs', '--stdout'], {
    cwd: fixture.mac, input, env: { ...stripScopedGitEnv({ ...process.env }) }, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkBytes) chunks.push(pack.subarray(offset, offset + chunkBytes));
  return chunks.length === 0 ? [Buffer.alloc(0)] : chunks;
}

/** Upload chunks the way this Mac does: in order, the last carrying `final`. */
export async function uploadChunks(fixture: Fixture, chunks: Buffer[], options: SendOptions): Promise<string> {
  const uploadId = options.uploadId ?? `upload-${String(++uploadCounter).padStart(6, '0')}`;
  for (let index = 0; index < chunks.length; index++) {
    if (options.only && !options.only.includes(index)) continue;
    const last = index === chunks.length - 1;
    await fixture.host.receive({
      project: options.project ?? PROJECT,
      jobId: options.jobId ?? JOB,
      uploadId,
      index,
      total: chunks.length,
      dataBase64: chunks[index]!.toString('base64'),
      ...(last ? { final: { commit: options.commit, baseTip: options.baseTip ?? null, startCommit: options.startCommit ?? options.commit } } : {}),
    });
  }
  return uploadId;
}

/** Send a commit the way this Mac does: a thin pack against `have`, in chunks, the last carrying `final`. */
export async function sendCommit(fixture: Fixture, options: SendOptions): Promise<{ uploadId: string; total: number; chunks: Buffer[] }> {
  const chunks = makeChunks(fixture, options.commit, options.have, options.chunkBytes);
  return { uploadId: await uploadChunks(fixture, chunks, options), total: chunks.length, chunks };
}

export function documents(files: Record<string, string>): QueueDocument[] {
  return Object.entries(files).map(([path, content]) => ({ path, contentBase64: Buffer.from(content).toString('base64') }));
}

/** Send the Mac's HEAD for a job and prepare its folder; returns the commit and the prepare result. */
export async function sendAndPrepare(fixture: Fixture, options: { docs?: Record<string, string>; turnId?: string; branch?: string; jobId?: string; commit?: string } = {}) {
  const commit = options.commit ?? runGit(['rev-parse', 'HEAD'], fixture.mac);
  await sendCommit(fixture, { commit, jobId: options.jobId });
  const prepared = await fixture.host.prepare({
    project: PROJECT, jobId: options.jobId ?? JOB, branch: options.branch ?? BRANCH, commit,
    documents: documents(options.docs ?? { 'docs/plans/p_plan.md': '# plan\n' }), turnId: options.turnId ?? 'turn-1',
  });
  return { commit, prepared };
}
