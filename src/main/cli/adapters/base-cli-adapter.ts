/**
 * Base CLI Adapter - Abstract base class for all CLI tool adapters
 * Provides a common interface for spawning and managing CLI processes
 * (Claude Code, OpenAI Codex, Google Gemini, etc.)
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getOutputPersistenceManager } from '../../context/output-persistence';
import { buildCliSpawnOptions } from '../cli-environment';
import { getPauseCoordinator } from '../../pause/pause-coordinator';
import { OrchestratorPausedError } from '../../pause/orchestrator-paused-error';
import { getClampedLoadWatchdogMultiplier } from '../../runtime/system-load-monitor';
import type { FileAttachment } from '../../../shared/types/instance.types';
import { estimateTokens as sharedEstimateTokens } from '../../../shared/utils/token-estimate';
import type { DegradedOutputSignals } from './degraded-output-classifier';
import type {
  AdapterCapabilities,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliMessage,
  CliResponse,
  CliSpawnMode,
  CliStatus,
  InterruptResult,
  SpawnModeChange,
} from './base-cli-adapter.types';
import {
  CliSpawnCwdError,
  computeBoundedTrigramSimilarity,
  directoryExists,
  enrichSpawnError,
  ndjsonSafeStringify,
} from './base-cli-adapter-utils';
import {
  isDegradedDetectionEnabled,
  tagResponseFromStreamState,
  tagResponseIfDegraded,
} from './base-cli-adapter-degraded-output';
import { killProcessGroup } from './base-cli-process-utils';
import {
  resolveWindowsCliLauncher,
  buildWindowsShellFreeTarget,
  logWindowsLauncherResolution,
  WindowsCliLauncher,
} from './windows-cli-spawn';
import { PosixSpawnCommandResolver } from './posix-spawn-command-resolver';
const logger = getLogger('BaseCliAdapter');
export { CliSpawnCwdError, computeBoundedTrigramSimilarity, directoryExists, enrichSpawnError, ndjsonSafeStringify };

/** Resolved spawn launcher. `detached` defaults to `!shell` when omitted. */
export interface SpawnTarget {
  command: string;
  args: string[];
  shell: boolean;
  detached?: boolean;
}

export type {
  AdapterCapabilities,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliAdapterEvents,
  CliAttachment,
  CliCapabilities,
  CliEvent,
  CliMessage,
  CliResponse,
  CliSpawnMode,
  CliStatus,
  CliToolCall,
  CliUsage,
  InterruptResult,
  ResumeAttemptResult,
  SpawnModeChange,
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

/** D9: Maximum time to wait for a kernel-buffer drain before treating the write as failed. */
const DRAIN_TIMEOUT_MS = 5_000;

/** D10: Maximum time after process spawn before the first byte must arrive. */
const POST_SPAWN_WATCHDOG_MS = 30_000;

export abstract class BaseCliAdapter extends EventEmitter {
  protected config: CliAdapterConfig;
  protected process: ChildProcess | null = null;
  protected sessionId: string | null = null;
  protected outputBuffer = '';

  /**
   * B9 — the transport this adapter is currently using. Defaults to
   * `subprocess-stream` (the persistent piped-subprocess path that Claude/Gemini
   * headless mode use). Adapters with a different transport declare it by
   * overriding this field or calling {@link setSpawnMode} once their mode is
   * known (e.g. Codex after deciding app-server vs exec). Read via
   * {@link getSpawnMode}; surfaced to diagnostics and the instance layer.
   */
  protected spawnMode: CliSpawnMode = 'subprocess-stream';

  /** Stream idle watchdog timer — resets on each stdout chunk */
  private streamIdleTimer: NodeJS.Timeout | null = null;
  private streamIdleTimeoutMs: number;
  /** D10: First-byte watchdog — armed on spawn, cleared on first stdout data */
  private postSpawnTimer: NodeJS.Timeout | null = null;

  // A3: degraded-output classifier state (only used when flag is on)
  /** Timestamp (ms) when the current process was spawned, for elapsed-time signals. */
  protected responseStartedAt = 0;
  /** Set to true if the stream-idle watchdog fired during the current response. */
  protected streamIdleDidFire = false;
  /**
   * Timestamp (ms) of the first observed output/activity of the CURRENT turn, or
   * 0 if none yet. Used as the elapsed-time origin so the signal is per-turn even
   * for persistent-session adapters (ACP, codex app-server) that spawn one
   * process and run many turns over it. Re-armed (set to 0) after each completed
   * turn. Falls back to `responseStartedAt` (spawn time) when a turn produced no
   * activity at all (a genuinely hung/empty turn, which we still want to flag).
   */
  private turnFirstActivityAt = 0;
  /**
   * Content of the previous finalized response on this adapter instance, used to
   * detect duplicate-stale / partial-replay output. Only written while the
   * `detectDegradedAdapterOutput` flag is on; null until the first tagged turn.
   * Persists across turns within the adapter lifetime (a session), intentionally
   * NOT reset per-spawn so cross-turn duplicates are detectable.
   */
  private priorResponseContent: string | null = null;

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
      killProcessGroup(proc.pid, 'SIGTERM');
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
      killProcessGroup(proc.pid, 'SIGTERM');
    }

    // Phase 2: wait for natural exit or the grace deadline.
    await exitPromise;

    // Phase 3: hard-kill anything still standing.
    for (const proc of pending) {
      killProcessGroup(proc.pid, 'SIGKILL');
    }
    BaseCliAdapter.activeProcesses.clear();
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
      killProcessGroup(pid, 'SIGTERM');

      // Wait for graceful shutdown with timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process && !this.process.killed) {
            killProcessGroup(pid, 'SIGKILL');
          }
          resolve();
        }, 5000);

        this.process?.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } else {
      killProcessGroup(pid, 'SIGKILL');
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
      const accepted = killProcessGroup(this.process.pid, 'SIGINT');
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
   * B9 — the transport this adapter is currently using. See {@link CliSpawnMode}.
   */
  getSpawnMode(): CliSpawnMode {
    return this.spawnMode;
  }

  /**
   * B9 — record the adapter's spawn mode and emit a `spawn_mode` event so the
   * instance layer can surface it (and so a silent degradation, e.g. Codex
   * app-server → exec, becomes a first-class, observable signal rather than a
   * buried warn log). No-op when the mode is unchanged.
   */
  protected setSpawnMode(
    mode: CliSpawnMode,
    opts: { reason?: string; degraded?: boolean } = {},
  ): void {
    if (mode === this.spawnMode) {
      return;
    }
    const previous = this.spawnMode;
    this.spawnMode = mode;
    const change: SpawnModeChange = {
      mode,
      previous,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts.degraded !== undefined ? { degraded: opts.degraded } : {}),
    };
    this.emit('spawn_mode', change);
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

  /**
   * Steer/interrupt capabilities for the resident-session redesign.
   *
   * When `liveInterrupt` is true, the orchestrator sends a `control_request`
   * (or provider-equivalent) instead of SIGINT to abort a turn, and the
   * process stays alive. When `liveSteer` is true, a new user message can be
   * delivered to the same process immediately after the interrupt without a
   * spawn cycle.
   *
   * Subclasses override this when they support resident operation (e.g. Claude
   * in `--print --input-format stream-json` mode, Codex app-server).
   */
  getAdapterCapabilities(): AdapterCapabilities {
    return { residentSession: false, liveInterrupt: false, liveSteer: false };
  }

  // ============ Protected Helper Methods ============

  /** Cached Windows launcher resolution: `undefined` = unattempted; `null` = failed. */
  private resolvedWindowsLauncher: WindowsCliLauncher | null | undefined;
  private readonly posixSpawnCommandResolver = new PosixSpawnCommandResolver();
  /**
   * Resolve the final spawn target just before `spawn()`. On Windows this maps
   * the `<cli>.cmd`/`.ps1` shim to a directly-spawnable launcher (native
   * `claude.exe`, or `node.exe` + package script for codex/copilot/…) with
   * `shell: false`, so a proper argv array survives cmd.exe (which otherwise
   * mangles args per DEP0190 — truncating at a multi-line `--system-prompt` and
   * dropping `--mcp-config`). Resolution failure falls back to the `shell: true`
   * shim; off-Windows / shell-false → identity. Subclasses may override.
   */
  protected resolveSpawnTarget(
    command: string,
    args: string[],
    spawnOptions: { shell?: boolean | string; env?: NodeJS.ProcessEnv },
  ): SpawnTarget {
    const shell = Boolean(spawnOptions.shell);
    if (process.platform !== 'win32' || !shell) {
      return { command: this.posixSpawnCommandResolver.resolve(command, spawnOptions.env), args, shell };
    }
    if (this.resolvedWindowsLauncher === undefined) {
      this.resolvedWindowsLauncher = resolveWindowsCliLauncher(command, spawnOptions.env ?? process.env);
      logWindowsLauncherResolution(logger, this.getName(), command, this.resolvedWindowsLauncher);
    }
    return this.resolvedWindowsLauncher
      ? buildWindowsShellFreeTarget(this.resolvedWindowsLauncher, args)
      : { command, args, shell: true };
  }

  /**
   * Spawn a CLI process with given arguments
   */
  protected spawnProcess(args: string[]): ChildProcess {
    // Validate the working directory up front. Node reports a nonexistent cwd
    // as `spawn <cmd> ENOENT` — indistinguishable from a missing binary — so
    // every future occurrence of this bug class (remote-node paths, deleted
    // worktrees) gets an actionable error instead of a misleading one.
    // An undefined cwd is untouched: spawn falls back to the process cwd.
    if (this.config.cwd && !directoryExists(this.config.cwd)) {
      throw new CliSpawnCwdError(this.config.command, this.config.cwd);
    }

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

    const target = this.resolveSpawnTarget(this.config.command, fullArgs, spawnOptions);
    const useShell = target.shell;
    const detached = target.detached ?? !useShell;

    const proc = spawn(target.command, target.args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...spawnOptions,
      shell: useShell,
      detached,
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
    proc.stdout?.on('data', () => {
      this.clearPostSpawnWatchdog();
      this.markTurnActivity();
      this.resetStreamIdleWatchdog(generation);
    });
    proc.stderr?.on('data', () => {
      this.clearPostSpawnWatchdog();
      this.emit('stderr');
      this.markTurnActivity();
      this.resetStreamIdleWatchdog(generation);
    });
    const heartbeatListener = () => {
      this.clearPostSpawnWatchdog();
      this.markTurnActivity();
      this.resetStreamIdleWatchdog(generation);
    };
    this.on('heartbeat', heartbeatListener);
    proc.on('close', () => {
      this.processAlive = false;
      this.clearPostSpawnWatchdog();
      this.clearStreamIdleWatchdog();
      this.off('heartbeat', heartbeatListener);
    });

    // D10: arm first-byte watchdog after process is running.
    this.armPostSpawnWatchdog(generation);

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
    this.markTurnActivity();
    this.resetStreamIdleWatchdog();
  }

  /**
   * A3: record the first activity timestamp of the current turn (used as the
   * per-turn elapsed-time origin). Idempotent within a turn — only the first
   * call after a re-arm takes effect. Cheap enough to run unconditionally on the
   * hot output path; the per-turn re-arm happens in {@link completeResponse}.
   */
  private markTurnActivity(): void {
    if (this.turnFirstActivityAt === 0) {
      this.turnFirstActivityAt = Date.now();
    }
  }

  /**
   * Start or reset the stream idle watchdog timer.
   * Call this whenever stdout data is received to reset the countdown.
   * @param generation - process generation token; callback is discarded if it doesn't match
   */
  protected resetStreamIdleWatchdog(generation?: number): void {
    this.clearStreamIdleWatchdog();
    const expectedGen = generation ?? this.processGeneration;
    // Host-load scaling: a starved-but-healthy CLI legitimately goes silent
    // while the machine is oversubscribed. Stretch the no-output cutoff by the
    // current load multiplier so we don't kill processes that only need CPU.
    const effectiveTimeoutMs = this.streamIdleTimeoutMs * this.loadMultiplier();
    this.streamIdleTimer = setTimeout(() => {
      // Guard: discard if process has exited or generation has changed
      // (prevents stale timer from previous process firing on a new one)
      if (!this.processAlive || expectedGen !== this.processGeneration) return;
      logger.warn('Stream idle timeout exceeded', {
        adapter: this.getName(),
        timeoutMs: effectiveTimeoutMs,
        baseTimeoutMs: this.streamIdleTimeoutMs,
        pid: this.getPid(),
      });
      // A3: record that the idle watchdog fired for the degraded-output classifier.
      this.streamIdleDidFire = true;
      this.emit('stream:idle', {
        adapter: this.getName(),
        timeoutMs: effectiveTimeoutMs,
        pid: this.getPid(),
      });
    }, effectiveTimeoutMs);
    if (this.streamIdleTimer.unref) this.streamIdleTimer.unref();
  }

  /** Current host-load watchdog multiplier (clamped, throw-safe). */
  private loadMultiplier(): number {
    return getClampedLoadWatchdogMultiplier();
  }

  /**
   * D10: Start the post-spawn first-byte watchdog.
   * Emits 'spawn:stall' if no stdout data arrives within POST_SPAWN_WATCHDOG_MS.
   */
  protected armPostSpawnWatchdog(generation: number): void {
    if (this.postSpawnTimer) clearTimeout(this.postSpawnTimer);
    // Host-load scaling: first-byte latency stretches with an oversubscribed CPU.
    const effectiveTimeoutMs = POST_SPAWN_WATCHDOG_MS * this.loadMultiplier();
    this.postSpawnTimer = setTimeout(() => {
      if (!this.processAlive || generation !== this.processGeneration) return;
      logger.warn('Post-spawn first-byte watchdog fired — no output after spawn', {
        adapter: this.getName(),
        timeoutMs: effectiveTimeoutMs,
        pid: this.getPid(),
      });
      this.emit('spawn:stall', { adapter: this.getName(), timeoutMs: effectiveTimeoutMs, pid: this.getPid() });
    }, effectiveTimeoutMs);
    if (this.postSpawnTimer.unref) this.postSpawnTimer.unref();
  }

  /** Clear the post-spawn first-byte watchdog (call on first stdout data or process close). */
  protected clearPostSpawnWatchdog(): void {
    if (this.postSpawnTimer) {
      clearTimeout(this.postSpawnTimer);
      this.postSpawnTimer = null;
    }
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
   * D9: bounded by DRAIN_TIMEOUT_MS; EPIPE during drain resolves immediately
   * so the upstream process-exit path handles the dead process.
   */
  protected async safeStdinWrite(data: string): Promise<void> {
    if (!this.process?.stdin?.writable) return;

    const canContinue = this.process.stdin.write(data);
    if (!canContinue) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`stdin drain timeout after ${DRAIN_TIMEOUT_MS}ms — process may be stuck`));
        }, DRAIN_TIMEOUT_MS);
        const onDrain = () => { cleanup(); resolve(); };
        const onError = (err: NodeJS.ErrnoException) => {
          cleanup();
          // EPIPE means the pipe is dead; let the process-exit handler take over.
          if (err.code === 'EPIPE') resolve();
          else reject(err);
        };
        const cleanup = () => {
          clearTimeout(timer);
          this.process?.stdin?.off('drain', onDrain);
          this.process?.stdin?.off('error', onError);
        };
        this.process!.stdin!.once('drain', onDrain);
        this.process!.stdin!.once('error', onError);
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
    return isDegradedDetectionEnabled();
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
    tagResponseIfDegraded({ adapterName: this.getName(), response, signals });
  }

  /**
   * A3: Finalize and emit a completed response.
   *
   * This is the single seam every adapter should funnel terminal responses
   * through instead of calling `this.emit('complete', response)` directly. It
   * runs the adapter-layer degraded-output classifier (tagging
   * `response.degradedReason` in place when the feature flag is on) and then
   * emits the `'complete'` event with the same object reference, so both the
   * event consumer and any awaited promise observe the tag.
   *
   * When `detectDegradedAdapterOutput` is off (the default) this is a thin
   * wrapper around `emit` with zero extra work.
   *
   * @param response The finalized CliResponse to tag and emit.
   * @param opts.cancelled Set true when the response is a partial emitted on an
   *   interrupt/kill path, so it can be classified `'cancelled'`.
   */
  protected completeResponse(
    response: CliResponse,
    opts?: { cancelled?: boolean },
  ): void {
    this.tagResponseFromStreamState(response, opts);
    this.emit('complete', response);
    // A3: re-arm per-turn state so persistent-session adapters (one process,
    // many turns) measure each subsequent turn independently. Done outside the
    // flag gate so state stays correct even if the flag is toggled mid-session.
    this.turnFirstActivityAt = 0;
    this.streamIdleDidFire = false;
  }

  /**
   * A3: Compute the standard degraded-output signals from this adapter's own
   * stream state (elapsed time, idle-watchdog flag) plus the response content
   * (emptiness ratio, duplicate/replay similarity vs the previous turn), then
   * tag the response. No-op and near-zero cost when the flag is off.
   *
   * Separated from `completeResponse` so adapters that build their response
   * before the emit site can tag without re-emitting, and so it is unit-testable
   * in isolation.
   */
  protected tagResponseFromStreamState(
    response: CliResponse,
    opts?: { cancelled?: boolean },
  ): void {
    // Fast-path: flag off → no classification, no prior-content bookkeeping.
    if (!this.isDegradedDetectionEnabled()) return;
    this.priorResponseContent = tagResponseFromStreamState({
      adapterName: this.getName(),
      response,
      opts,
      priorResponseContent: this.priorResponseContent,
      turnFirstActivityAt: this.turnFirstActivityAt,
      responseStartedAt: this.responseStartedAt,
      streamIdleDidFire: this.streamIdleDidFire,
    });
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
    return sharedEstimateTokens(content);
  }

}
