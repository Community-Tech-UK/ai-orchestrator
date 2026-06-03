/**
 * Base CLI Adapter - Abstract base class for all CLI tool adapters
 * Provides a common interface for spawning and managing CLI processes
 * (Claude Code, OpenAI Codex, Google Gemini, etc.)
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getOutputPersistenceManager } from '../../context/output-persistence';
import { buildCliSpawnOptions } from '../cli-environment';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import type { FileAttachment } from '../../../shared/types/instance.types';
import type { DegradedOutputSignals } from './degraded-output-classifier';
import { classifyDegradedOutput } from './degraded-output-classifier';
import type {
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliStatus,
  InterruptResult,
} from './base-cli-adapter.types';

const logger = getLogger('BaseCliAdapter');

/**
 * JSON.stringify that escapes U+2028 and U+2029.
 * These are valid JSON but act as line terminators in JavaScript,
 * silently splitting NDJSON messages when present in string values.
 */
export function ndjsonSafeStringify(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export type {
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliAdapterEvents,
  CliAttachment,
  CliCapabilities,
  CliEvent,
  CliMessage,
  CliResponse,
  CliStatus,
  CliToolCall,
  CliUsage,
  InterruptResult,
  ResumeAttemptResult,
  TurnInterruptCompletion,
} from './base-cli-adapter.types';

/**
 * Abstract base class for CLI adapters
 * All CLI tool adapters (Claude, Codex, Gemini, etc.) must extend this class
 */
/**
 * Default stream idle timeout in milliseconds.
 * If no data is received on stdout for this duration during active streaming,
 * a 'stream:idle' event is emitted. Configurable via STREAM_IDLE_TIMEOUT_MS
 * env var. Inspired by Claude Code 2.1.84 CLAUDE_STREAM_IDLE_TIMEOUT_MS.
 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

export abstract class BaseCliAdapter extends EventEmitter {
  protected config: CliAdapterConfig;
  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  protected outputBuffer = '';

  /** Stream idle watchdog timer — resets on each stdout chunk */
  private streamIdleTimer: NodeJS.Timeout | null = null;
  private streamIdleTimeoutMs: number;

  // A3: degraded-output classifier state (only used when flag is on)
  /** Timestamp (ms) when the current process was spawned, for elapsed-time signals. */
  protected responseStartedAt = 0;
  /** Set to true if the stream-idle watchdog fired during the current response. */
  protected streamIdleDidFire = false;

  /** Tracks all active child processes across all adapter instances for orphan cleanup. */
  private static activeProcesses = new Set<ChildProcess>();

  /**
   * Kill all active child processes (synchronous, best-effort). Called from the
   * emergency `cleanupSync()` path where we cannot await — sends a single
   * SIGTERM to every tracked process group and forgets. Prefer
   * `killAllActiveProcessesGraceful()` from the async shutdown path, which
   * escalates to SIGKILL so a wedged CLI cannot orphan.
   */
  static killAllActiveProcesses(): void {
    for (const proc of BaseCliAdapter.activeProcesses) {
      BaseCliAdapter.killProcessGroup(proc.pid, 'SIGTERM');
    }
    BaseCliAdapter.activeProcesses.clear();
  }

  /**
   * Drain every tracked child process group on app quit with escalation:
   * SIGTERM the whole set, wait up to `graceMs` for natural exit, then SIGKILL
   * any survivor (and its group). This is the no-zombie guarantee the bare
   * synchronous variant lacks — a CLI ignoring SIGTERM (mid-flush, wedged MCP
   * server, stuck language server) is force-killed rather than leaked.
   */
  static async killAllActiveProcessesGraceful(graceMs = 3000): Promise<void> {
    const procs = Array.from(BaseCliAdapter.activeProcesses);
    if (procs.length === 0) {
      return;
    }

    // Only wait on processes that haven't already exited.
    const pending = new Set(
      procs.filter((proc) => proc.exitCode === null && proc.signalCode === null),
    );

    // Register exit listeners BEFORE signalling so we can't miss a fast exit.
    const exitPromise = new Promise<void>((resolve) => {
      if (pending.size === 0) {
        resolve();
        return;
      }
      let timer: NodeJS.Timeout | null = null;
      const listeners = new Map<ChildProcess, () => void>();
      const settle = () => {
        if (timer) clearTimeout(timer);
        for (const [proc, listener] of listeners) {
          proc.removeListener('exit', listener);
        }
        resolve();
      };
      for (const proc of pending) {
        const listener = () => {
          pending.delete(proc);
          if (pending.size === 0) settle();
        };
        listeners.set(proc, listener);
        proc.once('exit', listener);
      }
      timer = setTimeout(settle, graceMs);
    });

    // Phase 1: polite signal to the whole set.
    for (const proc of procs) {
      BaseCliAdapter.killProcessGroup(proc.pid, 'SIGTERM');
    }

    // Phase 2: wait for natural exit or the grace deadline.
    await exitPromise;

    // Phase 3: hard-kill anything still standing.
    for (const proc of pending) {
      BaseCliAdapter.killProcessGroup(proc.pid, 'SIGKILL');
    }
    BaseCliAdapter.activeProcesses.clear();
  }

  /**
   * Kill an entire process group (the CLI process and all its children,
   * including MCP servers). Requires the process to have been spawned
   * with `detached: true` so it has its own process group.
   * Falls back to single-process kill if group kill fails.
   */
  private static killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
    if (pid === undefined) return false;
    if (process.platform === 'win32') {
      try {
        const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          timeout: 5000,
          windowsHide: true,
        });
        if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            process.kill(pid, signal);
            return true;
          } catch {
            return false;
          }
        }
        return result.status === 0;
      } catch {
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
    }
    try {
      // Negative PID sends signal to the entire process group
      process.kill(-pid, signal);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
        // Group kill failed for non-ESRCH reason — try single process
        try {
          process.kill(pid, signal);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /**
   * Generation counter — incremented on every spawnProcess() call so that
   * a stale timeout callback from a previous process cannot fire on the
   * current one (race fix flagged by GPT-5.4 review).
   */
  private processGeneration = 0;
  private processAlive = false;

  constructor(config: CliAdapterConfig) {
    super();
    this.config = {
      timeout: 300000, // 5 minute default
      maxRetries: 2,
      sessionPersistence: true,
      ...config,
    };
    this.streamIdleTimeoutMs = parseInt(
      process.env['STREAM_IDLE_TIMEOUT_MS'] || '', 10
    ) || DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  // ============ Abstract Methods - Must be implemented by each CLI adapter ============

  /**
   * Get the name of this CLI adapter
   */
  abstract getName(): string;

  /**
   * Get the capabilities of this CLI tool
   */
  abstract getCapabilities(): CliCapabilities;

  /**
   * Check if the CLI is available and properly configured
   */
  abstract checkStatus(): Promise<CliStatus>;

  /**
   * Send a message and get a response (non-streaming)
   */
  abstract sendMessage(message: CliMessage): Promise<CliResponse>;

  /**
   * Send a message and stream the response
   */
  abstract sendMessageStream(message: CliMessage): AsyncIterable<string>;

  /**
   * Parse raw CLI output into a standardized response
   */
  abstract parseOutput(raw: string): CliResponse;

  /**
   * Build CLI arguments for a given message
   */
  protected abstract buildArgs(message: CliMessage): string[];

  /**
   * Provider-specific implementation for sending renderer/user input.
   */
  protected abstract sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void>;

  // ============ Common Methods with Default Implementations ============

  /**
   * Initialize the CLI adapter (verify availability)
   */
  async initialize(): Promise<void> {
    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(`${this.getName()} CLI not available: ${status.error || 'Unknown error'}`);
    }
  }

  /**
   * Public user-input entry point shared by all local adapters.
   */
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (getPauseCoordinator().isPaused()) {
      throw new OrchestratorPausedError('CLI input refused while orchestrator is paused');
    }

    await this.sendInputImpl(message, attachments);
  }

  /**
   * Terminate the CLI process
   */
  async terminate(graceful = true): Promise<void> {
    if (!this.process) return;

    const pid = this.process.pid;

    if (graceful) {
      // Send SIGTERM to entire process group (CLI + MCP servers)
      BaseCliAdapter.killProcessGroup(pid, 'SIGTERM');

      // Wait for graceful shutdown with timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            BaseCliAdapter.killProcessGroup(pid, 'SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } else {
      BaseCliAdapter.killProcessGroup(pid, 'SIGKILL');
    }

    this.process = null;
    this.outputBuffer = '';
    this.clearStreamIdleWatchdog();
  }

  /**
   * Interrupt the CLI process (like Ctrl+C)
   * Sends SIGINT to the process to interrupt current operation
   * This pauses Claude's work without terminating the process
   */
  interrupt(): InterruptResult {
    if (!this.process || this.process.killed) {
      return { status: 'already-idle', reason: 'No running process to interrupt' };
    }

    try {
      // Send SIGINT (equivalent to Ctrl+C in terminal)
      const accepted = BaseCliAdapter.killProcessGroup(this.process.pid, 'SIGINT');
      // Note: Don't emit status here - the instance manager handles status updates
      // after interrupt. The CLI will emit 'waiting_for_input' when it's ready.
      if (!accepted) {
        return { status: 'rejected', reason: 'SIGINT was not delivered' };
      }
      return { status: 'accepted' };
    } catch (error) {
      logger.error('Failed to interrupt process', error instanceof Error ? error : new Error(String(error)));
      return {
        status: 'rejected',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the current session ID
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set the session ID
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Check if a process is currently running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Get the process ID if running
   */
  getPid(): number | null {
    return this.process?.pid || null;
  }

  /**
   * Get the adapter configuration
   */
  getConfig(): CliAdapterConfig {
    return { ...this.config };
  }

  /**
   * Runtime capabilities used by orchestrator lifecycle decisions.
   * Subclasses should override this to advertise provider-specific behavior.
   */
  getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    };
  }

  // ============ Protected Helper Methods ============

  /**
   * Spawn a CLI process with given arguments
   */
  protected spawnProcess(args: string[]): ChildProcess {
    const fullArgs = [...(this.config.args || []), ...args];

    // Extend PATH to include common CLI installation directories
    // This is needed for packaged Electron apps where PATH may be limited
    // Build safe environment: strip API keys, secrets, and sensitive credentials
    // from child processes to prevent cross-provider credential leakage.
    // Uses getSafeEnv() which filters via blocklist (24 vars), block patterns (9 regexes),
    // and secret detection. Also removes CLAUDECODE to prevent "nested session" errors.
    const safeEnv = getSafeEnvForTrustedProcess();
    delete safeEnv['CLAUDECODE'];
    const mergedEnv = { ...safeEnv, ...this.config.env };
    const spawnOptions = buildCliSpawnOptions(mergedEnv);

    const proc = spawn(this.config.command, fullArgs, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: !spawnOptions.shell,
      ...spawnOptions,
    });

    // Increment generation so stale watchdog callbacks from a previous
    // process are silently discarded (race condition fix).
    const generation = ++this.processGeneration;
    this.processAlive = true;

    // A3: reset per-response degraded-classifier state
    this.responseStartedAt = Date.now();
    this.streamIdleDidFire = false;

    if (proc.pid) {
      this.emit('spawned', proc.pid);
    }

    // Register for orphan cleanup on app shutdown.
    BaseCliAdapter.activeProcesses.add(proc);
    proc.on('exit', () => {
      BaseCliAdapter.activeProcesses.delete(proc);
    });

    // Wire stream idle watchdog: reset on stdout data, clear on process close.
    // We use 'close' rather than 'exit' because stdout may still have buffered
    // data after 'exit' fires (flagged by Copilot/gpt-5.2 review).
    //
    // FU-1: idle is "no meaningful activity", not just "no stdout". We reset
    // the watchdog on stderr too (test runners and build tools often log
    // progress only to stderr), and on `heartbeat` events that subclasses
    // emit when the process is demonstrably alive — codex's app-server
    // reasoning summaries, mcp tool calls, exec-mode liveness pings, etc.
    // External callers can also nudge the watchdog via `noteActivity()`.
    proc.stdout?.on('data', () => this.resetStreamIdleWatchdog(generation));
    proc.stderr?.on('data', () => {
      this.emit('stderr');
      this.resetStreamIdleWatchdog(generation);
    });
    const heartbeatListener = () => this.resetStreamIdleWatchdog(generation);
    this.on('heartbeat', heartbeatListener);
    proc.on('close', () => {
      this.processAlive = false;
      this.clearStreamIdleWatchdog();
      this.off('heartbeat', heartbeatListener);
    });

    // Guard against EPIPE errors on stdin/stdout — these occur when the CLI
    // process closes its pipe end before we finish writing (common on early exit).
    proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        logger.debug('EPIPE on stdin — CLI process closed pipe', {
          adapter: this.getName(),
          pid: proc.pid,
        });
        return;
      }
      // Non-EPIPE stdin errors are re-emitted as adapter errors
      this.emit('error', err);
    });

    proc.stdout?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') {
        logger.debug('EPIPE on stdout — consumer closed pipe', {
          adapter: this.getName(),
          pid: proc.pid,
        });
        return;
      }
      this.emit('error', err);
    });

    return proc;
  }

  /**
   * Returns true if the spawned process's stdin pipe is open and writable.
   * Use this guard before writing to stdin to avoid EPIPE errors on
   * processes that have already closed their pipe end.
   */
  protected isRealPipe(): boolean {
    return this.process?.stdin?.writable === true && !this.process.stdin.destroyed;
  }

  // ============ Stream Idle Watchdog ============

  /**
   * Override the stream-idle threshold (no-stdout cutoff) at runtime.
   * Used by callers like Loop Mode that have provider-specific tolerances.
   * Pass undefined to leave the existing value untouched.
   */
  setStreamIdleTimeoutMs(ms: number | undefined): void {
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
      this.streamIdleTimeoutMs = Math.floor(ms);
    }
  }

  /**
   * FU-1: external "I saw the child do meaningful work" nudge. Loop Mode
   * and other supervisors call this when they detect activity that the
   * adapter wouldn't otherwise count toward idle reset — e.g. a parsed
   * tool-use event handed off via the activity stream, a provider
   * progress notification from a thread channel, an assistant token
   * surfaced through a non-stdout transport. No-op if the watchdog is
   * not currently armed.
   */
  noteActivity(): void {
    if (!this.streamIdleTimer) return;
    this.resetStreamIdleWatchdog();
  }

  /**
   * Start or reset the stream idle watchdog timer.
   * Call this whenever stdout data is received to reset the countdown.
   * @param generation - process generation token; callback is discarded if it doesn't match
   */
  protected resetStreamIdleWatchdog(generation?: number): void {
    this.clearStreamIdleWatchdog();
    const expectedGen = generation ?? this.processGeneration;
    this.streamIdleTimer = setTimeout(() => {
      // Guard: discard if process has exited or generation has changed
      // (prevents stale timer from previous process firing on a new one)
      if (!this.processAlive || expectedGen !== this.processGeneration) return;
      logger.warn('Stream idle timeout exceeded', {
        adapter: this.getName(),
        timeoutMs: this.streamIdleTimeoutMs,
        pid: this.getPid(),
      });
      // A3: record that the idle watchdog fired for the degraded-output classifier.
      this.streamIdleDidFire = true;
      this.emit('stream:idle', {
        adapter: this.getName(),
        timeoutMs: this.streamIdleTimeoutMs,
        pid: this.getPid(),
      });
    }, this.streamIdleTimeoutMs);
    if (this.streamIdleTimer.unref) this.streamIdleTimer.unref();
  }

  /**
   * Clear the stream idle watchdog timer.
   * Call this when streaming completes or the process exits.
   */
  protected clearStreamIdleWatchdog(): void {
    if (this.streamIdleTimer) {
      clearTimeout(this.streamIdleTimer);
      this.streamIdleTimer = null;
    }
  }

  /**
   * Write to child stdin with backpressure handling.
   * Waits for drain if the kernel buffer is full.
   */
  protected async safeStdinWrite(data: string): Promise<void> {
    if (!this.process?.stdin?.writable) return;

    const canContinue = this.process.stdin.write(data);
    if (!canContinue) {
      await new Promise<void>((resolve) => {
        this.process!.stdin!.once('drain', resolve);
      });
    }
  }

  /**
   * Flush the accumulated output buffer, optionally externalising large content.
   *
   * Subclasses that accumulate output in `this.outputBuffer` and then process it
   * should call this instead of reading `this.outputBuffer` directly.  When
   * `persistLargeOutputs` is true (the default) and the buffer exceeds the
   * default threshold (50 K chars), the full content is saved to disk and a
   * compact preview is returned instead — preventing large tool outputs from
   * inflating the context window.
   *
   * The method resets `this.outputBuffer` to `''` after reading.
   */
  protected async flushOutputBuffer(toolName = 'default'): Promise<string> {
    const content = this.outputBuffer;
    this.outputBuffer = '';

    const persist = this.config.persistLargeOutputs ?? true;
    if (!persist) {
      return content;
    }

    return getOutputPersistenceManager().maybeExternalize(toolName, content);
  }

  /**
   * A3: Read whether the degraded-output detection feature flag is enabled.
   *
   * Separated into its own protected method so that unit tests can override it
   * without needing to mock the full SettingsManager module (which would require
   * intercepting CommonJS `require()` calls, not well-supported by Vitest's ESM
   * mock system). Production code reads the live setting; tests subclass and
   * override to inject a fixed value.
   *
   * Returns `false` (safe/off default) if SettingsManager is not yet initialized
   * or throws (e.g. in tests that don't boot Electron).
   */
  protected isDegradedDetectionEnabled(): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getSettingsManager } = require('../core/config/settings-manager') as {
        getSettingsManager: () => { get: (key: string) => unknown };
      };
      return getSettingsManager().get('detectDegradedAdapterOutput') === true;
    } catch {
      return false;
    }
  }

  /**
   * A3: Adapter-layer degraded-output detection hook.
   *
   * Classifies `response` against `signals` using the pure classifier and, if
   * a degraded reason is found, sets `response.degradedReason` in-place.
   *
   * This method is a no-op when `detectDegradedAdapterOutput` is false
   * (the default). When the flag is off, the function returns immediately
   * without running any classifier logic, so there is zero overhead on the
   * hot streaming path.
   *
   * Fail-soft: any unexpected exception inside the classifier is caught and
   * logged — it must never propagate into the stream or throw to the caller.
   *
   * Usage by subclasses (once they opt in):
   * ```ts
   * const response = this.parseOutput(raw);
   * this.tagResponseIfEnabled(response, {
   *   contentLength: raw.length,
   *   elapsedMs: Date.now() - this.responseStartedAt,
   *   streamIdleFired: this.streamIdleDidFire,
   *   cancelled: wasCancelled,
   *   duplicateOfPrior: false,
   * });
   * return response;
   * ```
   */
  protected tagResponseIfEnabled(
    response: CliResponse,
    signals: DegradedOutputSignals,
  ): void {
    // Fast-path: flag is off (default) → byte-identical behavior to before A3.
    if (!this.isDegradedDetectionEnabled()) return;

    // Flag is on — run the classifier, fail-soft on any exception.
    try {
      const result = classifyDegradedOutput(signals);
      if (result.degraded && result.reason) {
        response.degradedReason = result.reason;
        logger.debug('A3: degraded output detected', {
          adapter: this.getName(),
          reason: result.reason,
          contentLength: signals.contentLength,
          elapsedMs: signals.elapsedMs,
        });
      }
    } catch (err) {
      logger.warn('A3: degraded-output classifier threw unexpectedly (ignored)', {
        adapter: this.getName(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Generate a unique response ID
   */
  protected generateResponseId(): string {
    const prefix = this.getName().toLowerCase().replace(/\s+/g, '-');
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Estimate token usage from content length (rough approximation)
   */
  protected estimateTokens(content: string): number {
    // Rough estimate: ~4 characters per token
    return Math.ceil(content.length / 4);
  }

  /**
   * Create a timeout promise
   */
  protected createTimeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }

  /**
   * Run with timeout wrapper
   */
  protected async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs?: number
  ): Promise<T> {
    const timeout = timeoutMs || this.config.timeout || 300000;
    return Promise.race([
      promise,
      this.createTimeout(timeout, `${this.getName()} CLI timeout after ${timeout}ms`),
    ]);
  }
}
