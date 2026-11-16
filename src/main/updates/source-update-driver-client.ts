import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SourceUpdateActivation, SourceUpdateCandidate, SourceUpdateDriver } from './source-update-service';

const commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const absolute = z.string().refine(value => path.isAbsolute(value));
const configSchema = z.object({
  version: z.literal(1), repositoryPath: absolute, remote: z.literal('origin'), branch: z.literal('main'),
  appPath: absolute, nodePath: absolute, driverPath: absolute,
}).strict();
const sessionSchema = z.object({
  instanceId: z.string().min(1), historyEntryId: z.string().min(1), workingDirectory: absolute,
  providerSessionId: z.string().optional(), accountProfileId: z.string().optional(),
}).strict();
const probeSchema = z.object({ available: z.boolean(), commit: commit.optional() }).strict();
const candidateSchema = z.object({ commit, appPath: absolute }).strict();
const ackSchema = z.object({ acknowledged: z.boolean(), sessions: z.array(sessionSchema).max(10_000) }).strict();
const READY = z.object({ ready: z.literal(true) }).strict();
const MAX_PROTOCOL_BYTES = 4 * 1024 * 1024;
const refused = (): Error => new Error('The source update helper did not complete its request.');

/** An argument-only Node child protocol. No app/session capability or build output enters the renderer. */
export class SourceUpdateDriverClient implements SourceUpdateDriver {
  constructor(private readonly configPath: string) {}

  probe(request: { installedCommit: string }, signal: AbortSignal) {
    return this.request('probe', request, signal, probeSchema, 45_000);
  }

  build(request: { commit: string }, signal: AbortSignal): Promise<SourceUpdateCandidate> {
    return this.request('build', request, signal, candidateSchema, 30 * 60_000);
  }

  ack(request: { commit: string; pid: number; restored?: true }, signal: AbortSignal) {
    return this.request('ack', request, signal, ackSchema, 30_000);
  }

  prepare(
    request: Parameters<SourceUpdateDriver['prepare']>[0], signal: AbortSignal,
  ): Promise<SourceUpdateActivation> {
    signal.throwIfAborted();
    const child = this.launch('activate');
    return new Promise((resolve, reject) => {
      let buffer = '';
      let ready = false;
      let committed = false;
      let stopped = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
      };
      const abort = (): void => {
        if (committed || stopped) return;
        stopped = true;
        signal.removeEventListener('abort', abort);
        child.stdin.end(`${JSON.stringify({ action: 'abort' })}\n`);
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        killTimer.unref?.();
        finish(refused());
      };
      const timer = setTimeout(abort, 30_000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (ready) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > MAX_PROTOCOL_BYTES) { abort(); return; }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try { READY.parse(JSON.parse(buffer.slice(0, newline))); }
        catch { abort(); return; }
        ready = true;
        finish();
        resolve({
          commit: () => new Promise<void>((committedResolve, committedReject) => {
            if (stopped || committed || signal.aborted) { committedReject(refused()); return; }
            child.stdin.write(`${JSON.stringify({ action: 'commit' })}\n`, error => {
              if (error || stopped || signal.aborted) { abort(); committedReject(refused()); return; }
              committed = true;
              signal.removeEventListener('abort', abort);
              child.stdin.end();
              child.unref();
              child.stdout.destroy();
              child.stderr.destroy();
              child.stdin.destroy();
              committedResolve();
            });
          }),
          abort,
        });
      });
      child.on('error', () => {
        stopped = true;
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        finish(refused());
      });
      child.on('close', () => {
        stopped = true;
        clearTimeout(killTimer);
        signal.removeEventListener('abort', abort);
        if (!ready) finish(refused());
      });
      child.stdin.on('error', () => { if (!committed) abort(); });
      child.stderr.resume();
      child.stdin.write(`${JSON.stringify(request)}\n`);
      if (signal.aborted) abort();
    });
  }

  private launch(command: string): ChildProcessWithoutNullStreams {
    const stat = lstatSync(this.configPath);
    if (!stat.isFile() || stat.size > 64 * 1024 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) throw refused();
    const config = configSchema.parse(JSON.parse(readFileSync(this.configPath, 'utf8')));
    return spawn(config.nodePath, [config.driverPath, command, '--config', this.configPath], {
      cwd: path.dirname(this.configPath), detached: command === 'activate', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: `${path.dirname(config.nodePath)}${path.delimiter}${process.env['PATH'] ?? ''}`, GIT_TERMINAL_PROMPT: '0' },
    });
  }

  private request<T>(command: string, request: unknown, signal: AbortSignal, schema: z.ZodType<T>, timeoutMs: number): Promise<T> {
    signal.throwIfAborted();
    const child = this.launch(command);
    return new Promise((resolve, reject) => {
      let output = '';
      let failed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = (): void => {
        if (failed) return;
        failed = true;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        killTimer.unref?.();
      };
      const timer = setTimeout(abort, timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      const cleanup = (): void => { clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort); };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (Buffer.byteLength(output) > MAX_PROTOCOL_BYTES) abort();
      });
      child.stderr.resume();
      child.stdin.on('error', abort);
      child.on('error', () => { cleanup(); reject(refused()); });
      child.on('close', code => {
        cleanup();
        if (failed || signal.aborted || code !== 0) { reject(refused()); return; }
        try { resolve(schema.parse(JSON.parse(output.trim()))); }
        catch { reject(refused()); }
      });
      child.stdin.end(JSON.stringify(request));
      if (signal.aborted) abort();
    });
  }
}
