import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getLogger } from '../../main/logging/logger';
import type {
  QueueHaveParams, QueueHaveResult, QueueReceiveParams, QueueReceiveResult,
} from '../../main/remote-node/queue-job-rpc-schemas';
import { git, gitTry, GIT_LONG_TIMEOUT_MS } from './queue-git';
import type { QueueJobEnv } from './queue-job-env';

const logger = getLogger('QueueRepoStore');
const SWEEP_EVERY_MS = 5 * 60_000;

interface UploadState {
  project: string;
  jobId: string;
  total: number;
  sizes: Map<number, number>;
  bytes: number;
  touched: number;
}

export function queueRefName(jobId: string, which: 'sent' | 'base' | 'start' | 'collected'): string {
  return `refs/queue/${jobId}/${which}`;
}

/** The worker's bare repository per project, and the chunked uploads that fill it. */
export class QueueRepoStore {
  private readonly uploads = new Map<string, UploadState>();
  private readonly configured = new Set<string>();
  private lastSweep = 0;

  constructor(private readonly env: QueueJobEnv) {}

  /** Does this computer have a repository for the project yet? */
  async exists(project: string): Promise<boolean> {
    return fs.stat(path.join(this.env.paths.bareRepo(project), 'HEAD')).then(() => true, () => false);
  }

  /** Make the bare repository if it is not there; every call checks the settings that matter. */
  async ensureBare(project: string): Promise<string> {
    const bare = this.env.paths.bareRepo(project);
    if (!await this.exists(project)) {
      await fs.mkdir(this.env.paths.reposDir, { recursive: true });
      await git(['init', '--bare', '--quiet', bare], this.env.paths.reposDir);
      this.configured.delete(project);
    }
    if (!this.configured.has(project)) {
      // No remotes are ever added: nothing here can be pushed anywhere.
      for (const [key, value] of [['core.autocrlf', 'false'], ['core.longpaths', 'true'], ['gc.auto', '0']] as const) {
        await git(['config', key, value], bare);
      }
      this.configured.add(project);
    }
    return bare;
  }

  async refValue(project: string, ref: string): Promise<string | null> {
    if (!await this.exists(project)) return null;
    return gitTry(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], this.env.paths.bareRepo(project));
  }

  /** Which of these commits this computer already holds, so this Mac can leave them out of the pack. */
  async have(params: QueueHaveParams): Promise<QueueHaveResult> {
    if (params.candidates.length === 0 || !await this.exists(params.project)) return { have: [] };
    const listed = await git(['cat-file', '--batch-check'], this.env.paths.bareRepo(params.project), {
      input: `${params.candidates.join('\n')}\n`,
    });
    const have = listed.split('\n').flatMap(line => {
      const [sha, kind] = line.trim().split(' ');
      return sha && kind === 'commit' ? [sha] : [];
    });
    return { have };
  }

  async receive(params: QueueReceiveParams): Promise<QueueReceiveResult> {
    await this.sweepAbandoned();
    const state = await this.stateFor(params);
    await this.storeChunk(state, params);
    if (!params.final) return { complete: false };
    try {
      await this.env.mutex.run(`repo:${params.project}`, () => this.finish(state, params, params.final!));
    } catch (error) {
      if (error instanceof MissingChunkError) throw error; // the upload stays, so the missing chunk can still be sent
      await this.discardUpload(params.uploadId);
      throw error;
    }
    await this.discardUpload(params.uploadId);
    return { complete: true };
  }

  /** Delete uploads nobody has touched for `uploadMaxAgeMs`, such as one whose sender went away mid-way. */
  async sweepAbandoned(): Promise<void> {
    const now = this.env.now();
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    let names: string[];
    try { names = await fs.readdir(this.env.paths.uploadsDir); } catch { return; }
    for (const name of names) {
      try {
        const known = this.uploads.get(name);
        const touched = known?.touched ?? (await fs.stat(this.env.paths.uploadDir(name)).then(stat => stat.mtimeMs, () => now));
        if (now - touched > this.env.limits.uploadMaxAgeMs) {
          logger.info('Deleting an abandoned queue upload', { uploadId: name });
          await this.discardUpload(name);
        }
      } catch {
        /* not one of ours (not an upload id), or already gone: leave it */
      }
    }
  }

  async discardUpload(uploadId: string): Promise<void> {
    this.uploads.delete(uploadId);
    await fs.rm(this.env.paths.uploadDir(uploadId), { recursive: true, force: true });
  }

  private async stateFor(params: QueueReceiveParams): Promise<UploadState> {
    const known = this.uploads.get(params.uploadId);
    if (known) {
      this.assertSameUpload(known, params);
      known.touched = this.env.now();
      return known;
    }
    const dir = this.env.paths.uploadDir(params.uploadId);
    const state: UploadState = { project: params.project, jobId: params.jobId, total: params.total, sizes: new Map(), bytes: 0, touched: this.env.now() };
    const meta = await fs.readFile(path.join(dir, 'meta.json'), 'utf8').then(text => JSON.parse(text) as Partial<UploadState>, () => null);
    if (meta) {
      this.assertSameUpload({ ...state, project: String(meta.project), jobId: String(meta.jobId), total: Number(meta.total) }, params);
      for (const name of await fs.readdir(dir)) {
        const match = /^(\d+)\.part$/.exec(name);
        if (!match) continue;
        const size = (await fs.stat(path.join(dir, name))).size;
        state.sizes.set(Number(match[1]), size);
        state.bytes += size;
      }
    } else {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ project: params.project, jobId: params.jobId, total: params.total }), 'utf8');
    }
    this.uploads.set(params.uploadId, state);
    return state;
  }

  private assertSameUpload(state: Pick<UploadState, 'project' | 'jobId' | 'total'>, params: QueueReceiveParams): void {
    if (state.project !== params.project || state.jobId !== params.jobId || state.total !== params.total) {
      throw new Error('This upload id is already in use for a different job; start a new upload.');
    }
  }

  private async storeChunk(state: UploadState, params: QueueReceiveParams): Promise<void> {
    if (params.dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(params.dataBase64)) {
      throw new Error('A chunk of the job\'s code was not valid base64.');
    }
    const data = Buffer.from(params.dataBase64, 'base64');
    const previous = state.sizes.get(params.index) ?? 0;
    if (state.bytes - previous + data.length > this.env.limits.maxUploadBytes) {
      await this.discardUpload(params.uploadId);
      throw new Error('The job\'s code is larger than this computer accepts in one upload.');
    }
    const dir = this.env.paths.uploadDir(params.uploadId);
    const part = path.join(dir, `${params.index}.part`);
    await fs.writeFile(`${part}.tmp`, data);
    await fs.rename(`${part}.tmp`, part);
    state.bytes += data.length - previous;
    state.sizes.set(params.index, data.length);
  }

  private async finish(
    state: UploadState,
    params: QueueReceiveParams,
    final: NonNullable<QueueReceiveParams['final']>,
  ): Promise<void> {
    for (let index = 0; index < state.total; index++) {
      if (!state.sizes.has(index)) throw new MissingChunkError(index, state.total);
    }
    const bare = await this.ensureBare(params.project);
    const dir = this.env.paths.uploadDir(params.uploadId);
    const packFile = path.join(dir, 'upload.pack');
    const sink = createWriteStream(packFile);
    try {
      for (let index = 0; index < state.total; index++) {
        await pipeline(createReadStream(path.join(dir, `${index}.part`)), sink, { end: false });
      }
    } finally {
      await new Promise<void>(resolve => sink.end(resolve));
    }
    if (state.bytes > 0) {
      await git(['index-pack', '--stdin', '--fix-thin'], bare, { stdinFile: packFile, timeoutMs: GIT_LONG_TIMEOUT_MS });
    }
    for (const sha of [final.commit, final.baseTip, final.startCommit]) {
      if (sha && await gitTry(['cat-file', '-e', `${sha}^{commit}`], bare) === null) {
        throw new Error('This computer does not have the commit that was sent after unpacking it. The job\'s code was not stored.');
      }
    }
    await git(['update-ref', queueRefName(params.jobId, 'sent'), final.commit], bare);
    if (final.baseTip) await git(['update-ref', queueRefName(params.jobId, 'base'), final.baseTip], bare);
    else await git(['update-ref', '-d', queueRefName(params.jobId, 'base')], bare);
    // The starting commit is written once and never moved.
    if (await gitTry(['rev-parse', '--verify', '--quiet', queueRefName(params.jobId, 'start')], bare) === null) {
      await git(['update-ref', queueRefName(params.jobId, 'start'), final.startCommit], bare);
    }
    logger.info('Stored a queue job commit', { jobId: params.jobId, bytes: state.bytes });
  }
}

class MissingChunkError extends Error {
  constructor(index: number, total: number) {
    super(`Chunk ${index + 1} of ${total} of the job's code has not arrived, so nothing was stored.`);
    this.name = 'MissingChunkError';
  }
}
