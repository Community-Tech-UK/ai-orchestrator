import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { hermeticGitEnv } from './git-env';

// Bound one incomplete field, not the total status listing. This comfortably
// exceeds filesystem path limits and rejects an unterminated/malformed stream.
const MAX_FIELD_BYTES = 1024 * 1024;

export type StatusPathVisitor = (filePath: string, status: string) => void;

/** Incremental porcelain v1 -z parser; rename/copy entries carry two fields. */
export class GitStatusParser {
  private pending: Buffer = Buffer.alloc(0);
  private sourceStatus: string | undefined;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  constructor(private readonly visit: StatusPathVisitor) {}

  write(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(0, offset);
      const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
      if (this.pending.length + part.length > MAX_FIELD_BYTES) {
        throw new Error('Git status field exceeds the path safety limit');
      }
      const field = this.pending.length ? Buffer.concat([this.pending, part]) : part;
      if (end < 0) {
        // Copy so a small pending tail cannot retain an entire stdout chunk.
        this.pending = Buffer.from(field);
        return;
      }
      this.pending = Buffer.alloc(0);
      this.readField(this.decoder.decode(field));
      offset = end + 1;
    }
  }

  finish(): void {
    if (this.pending.length || this.sourceStatus !== undefined) {
      throw new Error('Git status output ended inside a record');
    }
  }

  private readField(field: string): void {
    if (this.sourceStatus !== undefined) {
      if (!field) throw new Error('Git status rename/copy source is empty');
      const status = this.sourceStatus;
      this.sourceStatus = undefined;
      this.visit(field, status);
      return;
    }
    if (!/^[ MADRCUT?!]{2} .+$/s.test(field) || field.startsWith('  ')) {
      throw new Error('Malformed Git status record');
    }
    const status = field.slice(0, 2);
    if ((status.includes('?') && status !== '??') || (status.includes('!') && status !== '!!')) {
      throw new Error('Malformed Git status code');
    }
    this.visit(field.slice(3), status);
    if (/[RC]/.test(status)) this.sourceStatus = status;
  }
}

/**
 * Inspect every root status path without buffering the whole checkout listing.
 * A visitor result is usable only after this promise resolves: process close,
 * complete framing and successful exit are all required, even after a match.
 */
export function readGitStatusPaths(
  cwd: string,
  visit: StatusPathVisitor,
  timeoutMs = 60_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parser = new GitStatusParser(visit);
    const child = spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
      cwd,
      env: hermeticGitEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let failure: Error | undefined;
    const fail = (error: Error) => {
      if (failure) return;
      failure = error;
      clearTimeout(timer);
      // A kill error may itself emit `error`; guard reentry before signalling.
      // Failure rejects promptly even if killing fails or a descendant keeps
      // the stdout pipe open. Only successful inspection must await close.
      try {
        child.kill('SIGKILL');
      } catch {
        // The original inspection error still makes the operation fail closed.
      }
      child.stdout.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Git status inspection timed out')), timeoutMs);

    child.on('error', fail);
    child.stdout.on('error', fail);
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        parser.write(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) return;
      if (code !== 0 || signal) return reject(new Error('Git status inspection failed'));
      try {
        parser.finish();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}
