/**
 * A second computer for specs: a real bare repository and real folders in a temporary directory behind the same
 * `QueueJobLink` the coordinator uses. It does what the worker's `queue.*` calls are specified to do (spec: "Out" and
 * "Back"), just enough for the remote-job specs: it unpacks what it is sent, makes a job folder at the sent commit, lets a test act as the agent
 * in that folder, and answers `queue.collect` with a commit on a side reference, a thin pack and the changed planning files.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  QUEUE_PACK_CHUNK_BYTES, type QueueCollectParams, type QueueCollectResult, type QueueDeleteLeftOutParams,
  type QueueFetchPackParams, type QueueHaveParams, type QueuePrepareParams, type QueueProjectCheckParams,
  type QueueReadReportParams, type QueueReceiveParams, type QueueRemoveParams,
} from '../../remote-node/queue-job-rpc-schemas';
import { QueueJobLinkError, type QueueJobLink } from './queue-job-link';

const AUTHOR = { GIT_AUTHOR_NAME: 'Far', GIT_AUTHOR_EMAIL: 'far@example.invalid', GIT_COMMITTER_NAME: 'Far', GIT_COMMITTER_EMAIL: 'far@example.invalid' };

export function runGitSync(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, input?: Buffer): string {
  const clean: NodeJS.ProcessEnv = { ...process.env, ...AUTHOR, ...env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) delete clean[key];
  return execFileSync('git', args, { cwd, env: clean, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trimEnd();
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function filesUnder(folder: string, base = folder): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const full = join(folder, entry.name);
    return entry.isDirectory() ? filesUnder(full, base) : [full.slice(base.length + 1).split('\\').join('/')];
  });
}

export class FakeComputer implements QueueJobLink {
  readonly root = mkdtempSync(join(tmpdir(), 'aio-fake-computer-'));
  readonly bare = join(this.root, 'bare.git');
  /** Names of the calls received, in order. */
  readonly calls: string[] = [];
  /** Every `queue.receive` call's chunk position and size. */
  readonly receives: { uploadId: string; index: number; total: number; bytes: number; final: boolean }[] = [];
  online = true;
  supported = true;
  sessionRunning = false;
  /** Make the nth `queue.receive` call (counting from 1) drop the connection. */
  dropReceiveAt: number | null = null;
  /** Replaces the answer to `queue.collect` when set. */
  collectOverride: ((params: QueueCollectParams) => QueueCollectResult) | null = null;
  private readonly uploads = new Map<string, Buffer[]>();
  private readonly packs = new Map<string, Buffer[]>();
  private readonly sent = new Map<string, { commit: string; baseTip: string | null; startCommit: string; branch?: string }>();
  private readonly baselines = new Map<string, Map<string, string>>();

  constructor() {
    runGitSync(['init', '--bare', '-q', this.bare], this.root);
  }

  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }

  jobFolder(jobId: string): string { return join(this.root, 'jobs', jobId, 'work'); }
  planningFolder(jobId: string): string { return join(this.root, 'jobs', jobId, 'docs'); }
  /** The commit the job was last sent, as recorded under the job's reference. */
  sentFor(jobId: string): { commit: string; baseTip: string | null; startCommit: string } | undefined { return this.sent.get(jobId); }
  hasCommit(sha: string): boolean {
    try { runGitSync(['cat-file', '-e', `${sha}^{commit}`], this.bare); return true; } catch { return false; }
  }

  // ---- acting as the agent --------------------------------------------------------------------
  agentWrite(jobId: string, rel: string, content: string | Buffer): void {
    const file = join(this.jobFolder(jobId), rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  agentDelete(jobId: string, rel: string): void { rmSync(join(this.jobFolder(jobId), rel), { force: true }); }
  agentGit(jobId: string, ...args: string[]): string { return runGitSync(args, this.jobFolder(jobId)); }
  agentWritePlanning(jobId: string, rel: string, content: string): void {
    const file = join(this.planningFolder(jobId), rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  agentDeletePlanning(jobId: string, rel: string): void { rmSync(join(this.planningFolder(jobId), rel), { force: true }); }

  // ---- the worker's calls ---------------------------------------------------------------------
  supports(): boolean { return this.online && this.supported; }

  private enter(name: string): void {
    this.calls.push(name);
    if (!this.online) throw new QueueJobLinkError('away', 'the fake computer is away');
  }

  async have(_nodeId: string, params: QueueHaveParams) {
    this.enter('have');
    return { have: params.candidates.filter(candidate => this.hasCommit(candidate)) };
  }

  async receive(_nodeId: string, params: QueueReceiveParams) {
    this.enter('receive');
    const bytes = Buffer.from(params.dataBase64, 'base64');
    this.receives.push({ uploadId: params.uploadId, index: params.index, total: params.total, bytes: bytes.length, final: params.final !== undefined });
    if (this.dropReceiveAt === this.receives.length) throw new QueueJobLinkError('away', 'the connection dropped');
    const parts = this.uploads.get(params.uploadId) ?? [];
    if (params.index !== parts.length) throw new Error(`chunk ${params.index} arrived but ${parts.length} were expected`);
    parts.push(bytes);
    this.uploads.set(params.uploadId, parts);
    if (!params.final) return { complete: false };
    const pack = Buffer.concat(parts);
    this.uploads.delete(params.uploadId);
    if (pack.length > 0) runGitSync(['index-pack', '--stdin', '--fix-thin'], this.bare, {}, pack);
    if (!this.hasCommit(params.final.commit)) return { complete: false };
    runGitSync(['update-ref', `refs/queue/${params.jobId}/sent`, params.final.commit], this.bare);
    this.sent.set(params.jobId, { commit: params.final.commit, baseTip: params.final.baseTip, startCommit: params.final.startCommit });
    return { complete: true };
  }

  async prepare(_nodeId: string, params: QueuePrepareParams) {
    this.enter('prepare');
    const work = this.jobFolder(params.jobId);
    if (existsSync(work)) runGitSync(['reset', '--hard', '-q', params.commit], work);
    else runGitSync(['worktree', 'add', '-q', '-B', params.branch, work, params.commit], this.bare);
    this.sent.set(params.jobId, { ...this.sent.get(params.jobId)!, commit: params.commit, branch: params.branch });
    const baseline = new Map<string, string>();
    for (const document of params.documents) {
      const bytes = Buffer.from(document.contentBase64, 'base64');
      const file = join(this.planningFolder(params.jobId), document.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      baseline.set(document.path, sha256(bytes));
    }
    this.baselines.set(params.jobId, baseline);
    return {
      jobFolder: work, planningFolder: this.planningFolder(params.jobId), reportFolder: join(this.root, 'reports'),
      reportFile: join(this.root, 'reports', `${params.turnId}.json`), provisioned: [], installed: false,
    };
  }

  async collect(_nodeId: string, params: QueueCollectParams): Promise<QueueCollectResult> {
    this.enter('collect');
    if (this.collectOverride) return this.collectOverride(params);
    const refuse = (reason: 'session-running' | 'wrong-parent' | 'agent-committed' | 'no-copy', message: string): QueueCollectResult => ({ refused: { reason, message } });
    const record = this.sent.get(params.jobId);
    const work = this.jobFolder(params.jobId);
    if (!record || !existsSync(work)) return refuse('no-copy', 'No copy of this job is here.');
    if (this.sessionRunning) return refuse('session-running', 'The agent is still running.');
    if (record.commit !== params.expectedParent) return refuse('wrong-parent', 'The last commit sent is not the one you named.');
    if (runGitSync(['rev-parse', 'HEAD'], work) !== record.commit) return refuse('agent-committed', 'The agent made a commit of its own.');
    const env = { GIT_INDEX_FILE: join(this.root, `index-${params.jobId}`) };
    runGitSync(['read-tree', 'HEAD'], work, env);
    runGitSync(['add', '-A'], work, env);
    const tree = runGitSync(['write-tree'], work, env);
    const commit = runGitSync(['commit-tree', tree, '-p', record.commit, '-m', 'collected'], work, env);
    runGitSync(['update-ref', `refs/queue/${params.jobId}/collected`, commit], this.bare);
    const pack = Buffer.from(execFileSync('git', ['pack-objects', '--revs', '--thin', '--stdout', '--quiet'], {
      cwd: this.bare, input: `${commit}\n^${record.commit}\n`, maxBuffer: 256 * 1024 * 1024,
    }));
    const chunks: Buffer[] = [];
    for (let at = 0; at < pack.length; at += QUEUE_PACK_CHUNK_BYTES) chunks.push(pack.subarray(at, at + QUEUE_PACK_CHUNK_BYTES));
    const packId = randomUUID();
    this.packs.set(packId, chunks);
    const baseline = this.baselines.get(params.jobId) ?? new Map<string, string>();
    const documents = filesUnder(this.planningFolder(params.jobId)).flatMap(rel => {
      const bytes = readFileSync(join(this.planningFolder(params.jobId), rel));
      return baseline.get(rel) === sha256(bytes) ? [] : [{ path: rel, contentBase64: bytes.toString('base64') }];
    });
    const deleted = [...baseline.keys()].filter(rel => !existsSync(join(this.planningFolder(params.jobId), rel)));
    return { commit, packId, packChunks: chunks.length, documents, deleted };
  }

  async fetchPack(_nodeId: string, params: QueueFetchPackParams) {
    this.enter('fetchPack');
    return { dataBase64: this.packs.get(params.packId)![params.index].toString('base64') };
  }

  async readReport(_nodeId: string, _params: QueueReadReportParams) { this.enter('readReport'); return { text: null }; }

  async deleteLeftOut(_nodeId: string, params: QueueDeleteLeftOutParams) {
    this.enter('deleteLeftOut');
    for (const file of params.files) rmSync(join(this.jobFolder(params.jobId), file), { force: true });
    return { deleted: [...params.files], skipped: [] };
  }

  async remove(_nodeId: string, params: QueueRemoveParams) {
    this.enter('remove');
    const present = existsSync(join(this.root, 'jobs', params.jobId));
    rmSync(join(this.root, 'jobs', params.jobId), { recursive: true, force: true });
    return { removed: present };
  }

  /** The answer to `queue.projectCheck`; a test sets it. */
  checkResult: { ok: boolean; steps: { name: string; ms: number; ok: boolean; tail: string }[]; copyMs: number | null; problem: string | null } = {
    ok: true, steps: [{ name: 'typecheck', ms: 8_000, ok: true, tail: '' }, { name: 'lint', ms: 35_000, ok: true, tail: '' }], copyMs: 200, problem: null,
  };
  async projectCheck(_nodeId: string, _params: QueueProjectCheckParams) { this.enter('projectCheck'); return this.checkResult; }

  /** Sizes of files in the job folder, for asserting the far side holds a commit's files. */
  farFileSize(jobId: string, rel: string): number { return statSync(join(this.jobFolder(jobId), rel)).size; }
}

/** This Mac for specs: a repository on `main` and a job folder on its own branch, like the Plan Queue makes. */
export class FakeMac {
  readonly root = mkdtempSync(join(tmpdir(), 'aio-fake-mac-'));
  readonly repo = join(this.root, 'repo');
  readonly job = join(this.root, 'job');
  readonly branch = 'queue/job-1';

  constructor(files: Record<string, string | Buffer> = { 'README.md': 'hello\n', 'src/a.txt': 'a\n', 'src/b.txt': 'b\n' }) {
    mkdirSync(this.repo, { recursive: true });
    this.git(['init', '-q', '-b', 'main']);
    this.git(['config', 'user.email', 'mac@example.invalid']);
    this.git(['config', 'user.name', 'Mac']);
    this.git(['config', 'commit.gpgsign', 'false']);
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
    this.git(['add', '-A']);
    this.git(['commit', '-q', '-m', 'start']);
    this.git(['worktree', 'add', '-q', '-b', this.branch, this.job]);
  }

  git(args: string[], cwd = this.repo): string { return runGitSync(args, cwd); }
  head(cwd = this.job): string { return this.git(['rev-parse', 'HEAD'], cwd); }
  write(rel: string, content: string | Buffer, base = this.repo): void {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), content);
  }
  read(rel: string, base = this.job): string { return readFileSync(join(base, rel), 'utf8'); }
  /** What the queue's save does to the job folder: stage everything and commit (planning files are not handled here). */
  save(message = 'save', cwd = this.job): string {
    this.git(['add', '-A'], cwd);
    this.git(['commit', '-q', '--allow-empty', '-m', message], cwd);
    return this.head(cwd);
  }
  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }
}
