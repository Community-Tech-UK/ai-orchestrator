import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as util from 'util';

/**
 * Always-on rotating file logger for the worker agent.
 *
 * The worker currently logs via `console.*` only. When it is launched headless
 * (a Windows Startup VBS with `WScript.Shell.Run ..., 0, False`, a detached
 * process, or any PM2-less supervisor) that output is discarded — so when the
 * process crashes there is zero forensic evidence of why. This module tees every
 * `console.log/info/warn/error/debug` line to a size-capped, rotated log file
 * under `~/.orchestrator/logs/` so a post-mortem always has something to read.
 *
 * Deliberately dependency-light: workers must not transitively import `electron`
 * (see memory note "Worker electron import isolation"), so this uses only Node
 * built-ins. Writes are synchronous (`appendFileSync`) so the last lines before a
 * crash are always flushed to disk.
 *
 * Service mode (WinSW `--service-run`) already redirects stdout/stderr to a
 * `logpath`, so callers should NOT install this there to avoid double-logging.
 */

export interface WorkerFileLoggerOptions {
  /** Directory for log files. Defaults to `~/.orchestrator/logs`. */
  logDir?: string;
  /** Base log file name. Defaults to `worker-agent.log`. */
  fileName?: string;
  /** Rotate once the active file would exceed this many bytes. Default 5 MB. */
  maxBytes?: number;
  /** How many rotated files to keep (`.1` … `.N`). Default 4. */
  maxFiles?: number;
  /** Also mirror to the original console methods. Default true. */
  mirrorToConsole?: boolean;
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const CONSOLE_METHODS: ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];

export class WorkerFileLogger {
  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly mirrorToConsole: boolean;
  private currentSize = 0;
  private installed = false;
  private disabled = false;
  private readonly originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  constructor(options: WorkerFileLoggerOptions = {}) {
    const logDir = options.logDir ?? path.join(os.homedir(), '.orchestrator', 'logs');
    this.filePath = path.join(logDir, options.fileName ?? 'worker-agent.log');
    this.maxBytes = Math.max(1024, options.maxBytes ?? 5 * 1024 * 1024);
    this.maxFiles = Math.max(1, options.maxFiles ?? 4);
    this.mirrorToConsole = options.mirrorToConsole ?? true;

    try {
      fs.mkdirSync(logDir, { recursive: true });
      try {
        this.currentSize = fs.statSync(this.filePath).size;
      } catch {
        this.currentSize = 0;
      }
    } catch {
      // If we cannot even create the log directory, degrade to console-only.
      this.disabled = true;
    }
  }

  /** Absolute path of the active log file (for diagnostics). */
  get path(): string {
    return this.filePath;
  }

  /**
   * Patch the global console so every level also lands in the log file. Safe to
   * call once; subsequent calls are ignored. Returns `this` for chaining.
   */
  install(): this {
    if (this.installed || this.disabled) {
      return this;
    }
    this.installed = true;
    for (const method of CONSOLE_METHODS) {
      const original = console[method].bind(console) as (...args: unknown[]) => void;
      this.originals.set(method, original);
      console[method] = (...args: unknown[]): void => {
        this.append(method, args);
        if (this.mirrorToConsole) {
          original(...args);
        }
      };
    }
    return this;
  }

  /** Restore the original console methods (used by tests / clean shutdown). */
  uninstall(): void {
    if (!this.installed) {
      return;
    }
    for (const method of CONSOLE_METHODS) {
      const original = this.originals.get(method);
      if (original) {
        console[method] = original;
      }
    }
    this.originals.clear();
    this.installed = false;
  }

  /**
   * Write an explicit structured lifecycle line, independent of console. Useful
   * for the supervisor and connection lifecycle where we want a guaranteed file
   * record even if console mirroring is off.
   */
  write(level: string, message: string, meta?: Record<string, unknown>): void {
    const suffix = meta && Object.keys(meta).length > 0 ? ` ${safeStringify(meta)}` : '';
    this.appendLine(level, `${message}${suffix}`);
  }

  private append(method: ConsoleMethod, args: unknown[]): void {
    if (this.disabled) {
      return;
    }
    try {
      const formatted = args
        .map((a) => (typeof a === 'string' ? a : formatArg(a)))
        .join(' ');
      this.appendLine(method, formatted);
    } catch {
      // Never let logging throw into the hot path.
    }
  }

  private appendLine(level: string, text: string): void {
    if (this.disabled) {
      return;
    }
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${text}\n`;
    const bytes = Buffer.byteLength(line, 'utf-8');
    try {
      if (this.currentSize + bytes > this.maxBytes) {
        this.rotate();
      }
      fs.appendFileSync(this.filePath, line, 'utf-8');
      this.currentSize += bytes;
    } catch {
      // If the write fails (disk full, permissions), disable to avoid a tight
      // error loop; console mirroring still runs.
      this.disabled = true;
    }
  }

  private rotate(): void {
    try {
      // Drop the oldest, then shift each file up one slot: .N-1 -> .N.
      const oldest = `${this.filePath}.${this.maxFiles}`;
      if (fs.existsSync(oldest)) {
        fs.rmSync(oldest, { force: true });
      }
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        const to = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
        }
      }
      if (fs.existsSync(this.filePath)) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
      }
    } catch {
      // Rotation failed — truncate the active file as a last resort so it does
      // not grow unbounded.
      try {
        fs.writeFileSync(this.filePath, '', 'utf-8');
      } catch {
        this.disabled = true;
      }
    }
    this.currentSize = 0;
  }
}

function formatArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }
  return util.inspect(value, { depth: 4, breakLength: Infinity });
}

function safeStringify(meta: Record<string, unknown>): string {
  try {
    return JSON.stringify(meta);
  } catch {
    return util.inspect(meta, { depth: 3, breakLength: Infinity });
  }
}

let activeLogger: WorkerFileLogger | null = null;

/**
 * Install file logging for the worker agent process. Idempotent — a second call
 * returns the already-installed logger. Intended to be called once at startup in
 * non-service mode.
 */
export function installWorkerFileLogging(
  options: WorkerFileLoggerOptions = {},
): WorkerFileLogger {
  if (activeLogger) {
    return activeLogger;
  }
  activeLogger = new WorkerFileLogger(options).install();
  return activeLogger;
}
