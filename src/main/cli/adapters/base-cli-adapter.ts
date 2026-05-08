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

/**
 * Configuration for CLI adapters
 */
export interface CliAdapterConfig {
  /** CLI executable command/path */
  command: string;
  /** Default arguments for the CLI */
  args?: string[];
  /** Working directory for the CLI process */
  cwd?: string;
  /** Default timeout in milliseconds */
  timeout?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Maximum retry count on failure */
  maxRetries?: number;
  /** Support session persistence/resumption */
  sessionPersistence?: boolean;
  /**
   * When true (default), large accumulated output buffers are persisted to disk
   * and replaced with a compact preview before being processed further.
   * Disable only in contexts where full output must be retained in-process.
   */
  persistLargeOutputs?: boolean;
}

/**
 * Capabilities supported by a CLI tool
 */
export interface CliCapabilities {
  /** Real-time output streaming */
  streaming: boolean;
  /** Can execute tools/functions */
  toolUse: boolean;
  /** Can read/write files */
  fileAccess: boolean;
  /** Can run shell commands */
  shellExecution: boolean;
  /** Supports multi-turn conversations */
  multiTurn: boolean;
  /** Can process images */
  vision: boolean;
  /** Can execute code */
  codeExecution: boolean;
  /** Maximum context window (tokens) */
  contextWindow: number;
  /** Supported output formats */
  outputFormats: string[];
}

/**
 * Runtime orchestration capabilities that influence lifecycle behavior.
 */
export interface AdapterRuntimeCapabilities {
  /** Supports native session resume across adapter spawns */
  supportsResume: boolean;
  /** Supports forking a resumed session into a new session ID */
  supportsForkSession: boolean;
  /** Supports provider-native context compaction */
  supportsNativeCompaction: boolean;
  /** Supports interactive permission/input-required prompts */
  supportsPermissionPrompts: boolean;
  /** Supports defer-based permission flow via PreToolUse hooks (Claude CLI 2.1.90+) */
  supportsDeferPermission: boolean;
}

/**
 * Message to send to a CLI
 */
export interface CliMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: CliAttachment[];
  metadata?: Record<string, unknown>;
}

/**
 * Attachment for CLI messages
 */
export interface CliAttachment {
  type: 'file' | 'image' | 'code';
  path?: string;
  content?: string;
  mimeType?: string;
  name?: string;
}

/**
 * Response from a CLI
 */
export interface CliResponse {
  id: string;
  content: string;
  role: 'assistant';
  toolCalls?: CliToolCall[];
  usage?: CliUsage;
  metadata?: Record<string, unknown>;
  /** Original CLI output for debugging */
  raw?: unknown;
}

/**
 * Tool call made by a CLI
 */
export interface CliToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
}

/**
 * Usage statistics from a CLI
 */
export interface CliUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
  duration?: number;
}

/**
 * Status of a CLI tool
 */
export interface CliStatus {
  available: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  error?: string;
  /** Adapter-specific metadata (e.g., { appServerAvailable: boolean } for Codex). */
  metadata?: Record<string, unknown>;
}

export interface TurnInterruptCompletion {
  status: 'accepted' | 'interrupted' | 'completed' | 'cancelled' | 'rejected' | 'unknown';
  turnId?: string;
  reason?: string;
}

export interface InterruptResult {
  status: 'accepted' | 'rejected' | 'already-idle' | 'no-active-turn' | 'unsupported' | 'escalated';
  turnId?: string;
  reason?: string;
  completion?: Promise<TurnInterruptCompletion>;
}

export interface ResumeAttemptResult {
  source: 'native' | 'running-adopted' | 'jsonl-scan' | 'fresh-fallback' | 'replay' | 'none';
  confirmed: boolean;
  requestedSessionId?: string;
  actualSessionId?: string;
  requestedCursor?: unknown;
  actualCursor?: unknown;
  restoredTurnCount?: number;
  restoredMessageIds?: string[];
  reason?: string;
}

/**
 * Events emitted by CLI adapters
 */
export type CliEvent =
  | 'output'      // Streaming content
  | 'tool_use'    // Tool invocation
  | 'tool_result' // Tool response
  | 'status'      // Status update
  | 'error'       // Error occurred
  | 'complete'    // Response finished
  | 'exit'        // Process exited
  | 'spawned';    // Process spawned

/**
 * Event handler types for CLI adapters
 */
export interface CliAdapterEvents {
  'output': (content: string) => void;
  'tool_use': (toolCall: CliToolCall) => void;
  'tool_result': (toolCall: CliToolCall) => void;
  'status': (status: string) => void;
  'error': (error: Error | string) => void;
  'complete': (response: CliResponse) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'spawned': (pid: number) => void;
}

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

  /** Tracks all active child processes across all adapter instances for orphan cleanup. */
  private static activeProcesses = new Set<ChildProcess>();

  /**
   * Kill all active child processes. Called during app shutdown
   * to prevent orphans when Electron exits.
   */
  static killAllActiveProcesses(): void {
    for (const proc of BaseCliAdapter.activeProcesses) {
      BaseCliAdapter.killProcessGroup(proc.pid, 'SIGTERM');
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
    proc.stdout?.on('data', () => this.resetStreamIdleWatchdog(generation));
    proc.stderr?.on('data', () => this.emit('stderr'));
    proc.on('close', () => {
      this.processAlive = false;
      this.clearStreamIdleWatchdog();
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
