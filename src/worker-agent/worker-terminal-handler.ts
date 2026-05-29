/**
 * Worker-side handler for the `terminal.*` RPC methods (Piece C — remote terminal).
 *
 * Spawns and manages node-pty PTYs on the worker machine on behalf of the
 * coordinator. Mirrors the shape of `SyncHandler` / the instance manager:
 *  - `cwd` is sandboxed to the worker's allowed roots before any PTY is spawned;
 *  - PTY output is coalesced into batches (like the instance output batcher) so a
 *    chatty build doesn't flood the WebSocket one byte at a time;
 *  - lifecycle is reported back through injected callbacks, which the WorkerAgent
 *    turns into `terminal.output` / `terminal.exit` notifications.
 *
 * node-pty is a NATIVE, lazily-loaded optional dependency. It is required only
 * when the first terminal is actually spawned (see {@link lazyDefaultSpawn}) so a
 * worker without a PTY runtime still starts and serves instance/fs/sync traffic.
 * Tests inject a fake spawn function and never touch the native module.
 *
 * The canonical wire contract for these payloads is the Zod schema set in
 * `src/main/remote-node/rpc-schemas.ts` (TerminalCreate/Input/Resize/Kill). This
 * file re-validates shape locally with cheap guards to avoid pulling the
 * coordinator's schema module (and its `@contracts`/zod graph) into the lean
 * worker bundle.
 */

import * as os from 'os';
import { isPathAllowed } from './path-sandbox';

/**
 * Minimal subset of node-pty's `IPty` that we depend on. Declared locally so the
 * worker type-checks and bundles without `@types/node-pty`.
 */
export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

/** Matches `node-pty`'s `spawn(file, args, options)` for the bits we use. */
export type PtySpawnFn = (
  file: string,
  args: string[] | string,
  options: PtySpawnOptions,
) => PtyProcessLike;

export interface TerminalCreateRequest {
  sessionId: string;
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface WorkerTerminalCallbacks {
  /** Called with coalesced PTY output for a session. */
  onOutput: (sessionId: string, data: string) => void;
  /** Called once when a session's PTY exits. */
  onExit: (sessionId: string, exitCode: number | null, signal: string | null) => void;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
const MAX_DIMENSION = 10_000;
const OUTPUT_FLUSH_INTERVAL_MS = 30;
const OUTPUT_FLUSH_MAX_CHARS = 16_384;
const MAX_SESSIONS = 16;

interface ManagedSession {
  pty: PtyProcessLike;
  buffer: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

let cachedSpawn: PtySpawnFn | null = null;

/**
 * Lazily `require('node-pty')` on first use. Kept out of the module's import
 * graph so a worker without the native module starts normally.
 */
function lazyDefaultSpawn(): PtySpawnFn {
  if (!cachedSpawn) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('node-pty') as { spawn: PtySpawnFn };
    cachedSpawn = mod.spawn;
  }
  return cachedSpawn;
}

/** Resolve the default interactive shell for the host platform. */
export function defaultShellForPlatform(platform: NodeJS.Platform = os.platform()): string {
  if (platform === 'win32') {
    return process.env['ComSpec'] || 'powershell.exe';
  }
  return process.env['SHELL'] || '/bin/bash';
}

function clampDimension(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 1) return fallback;
  return Math.min(rounded, MAX_DIMENSION);
}

function buildEnv(overrides?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  return env;
}

export class WorkerTerminalHandler {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly explicitSpawn: PtySpawnFn | null;

  constructor(
    private readonly allowedRoots: string[],
    private readonly callbacks: WorkerTerminalCallbacks,
    spawnFn?: PtySpawnFn,
  ) {
    this.explicitSpawn = spawnFn ?? null;
  }

  /** Number of live PTY sessions. */
  sessionCount(): number {
    return this.sessions.size;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  create(req: TerminalCreateRequest): { sessionId: string; pid: number } {
    if (!req || typeof req.sessionId !== 'string' || req.sessionId.length === 0) {
      throw new Error('terminal.create requires a non-empty sessionId');
    }
    if (this.sessions.has(req.sessionId)) {
      throw new Error(`Terminal session already exists: ${req.sessionId}`);
    }
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Too many terminal sessions on this node (max ${MAX_SESSIONS})`);
    }
    if (typeof req.cwd !== 'string' || req.cwd.length === 0) {
      throw new Error('terminal.create requires a non-empty cwd');
    }
    if (!isPathAllowed(req.cwd, this.allowedRoots)) {
      throw new Error(`Terminal cwd outside allowed roots: ${req.cwd}`);
    }

    const cols = clampDimension(req.cols, DEFAULT_COLS);
    const rows = clampDimension(req.rows, DEFAULT_ROWS);
    const shell = req.shell && req.shell.trim().length > 0 ? req.shell : defaultShellForPlatform();
    const env = buildEnv(req.env);

    const spawn = this.explicitSpawn ?? lazyDefaultSpawn();
    const pty = spawn(shell, [], {
      name: 'xterm-color',
      cols,
      rows,
      cwd: req.cwd,
      env,
    });

    const session: ManagedSession = { pty, buffer: '', flushTimer: null };
    this.sessions.set(req.sessionId, session);

    pty.onData((data: string) => this.bufferOutput(req.sessionId, data));
    pty.onExit(({ exitCode, signal }) => {
      this.flush(req.sessionId);
      this.clearTimer(session);
      this.sessions.delete(req.sessionId);
      this.callbacks.onExit(
        req.sessionId,
        typeof exitCode === 'number' ? exitCode : null,
        signal != null ? String(signal) : null,
      );
    });

    return { sessionId: req.sessionId, pid: pty.pid };
  }

  input(sessionId: string, data: string): void {
    const session = this.requireSession(sessionId);
    session.pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.requireSession(sessionId);
    session.pty.resize(clampDimension(cols, DEFAULT_COLS), clampDimension(rows, DEFAULT_ROWS));
  }

  kill(sessionId: string, signal?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return; // idempotent — already gone
    try {
      session.pty.kill(signal);
    } finally {
      this.clearTimer(session);
      // Do not delete here: the PTY's onExit handler removes the session and
      // emits the exit notification. Killing only requests termination.
    }
  }

  /** Terminate every PTY — called on worker shutdown. */
  killAll(): void {
    for (const [sessionId, session] of this.sessions) {
      this.clearTimer(session);
      try {
        session.pty.kill();
      } catch {
        // best-effort
      }
      this.sessions.delete(sessionId);
    }
  }

  private requireSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Terminal session not found: ${sessionId}`);
    }
    return session;
  }

  private bufferOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.buffer += data;

    if (session.buffer.length >= OUTPUT_FLUSH_MAX_CHARS) {
      this.flush(sessionId);
      return;
    }
    if (!session.flushTimer) {
      session.flushTimer = setTimeout(() => this.flush(sessionId), OUTPUT_FLUSH_INTERVAL_MS);
      if (typeof session.flushTimer.unref === 'function') {
        session.flushTimer.unref();
      }
    }
  }

  private flush(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.clearTimer(session);
    if (session.buffer.length === 0) return;
    const data = session.buffer;
    session.buffer = '';
    this.callbacks.onOutput(sessionId, data);
  }

  private clearTimer(session: ManagedSession): void {
    if (session.flushTimer) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  }
}
