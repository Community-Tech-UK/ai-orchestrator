/**
 * Codex CLI Adapter - Spawns and manages OpenAI Codex CLI processes
 * https://github.com/openai/codex
 *
 * Dual-mode operation:
 *   1. **App-server mode** (preferred): persistent JSON-RPC server via
 *      `codex app-server` with real-time streaming, native threads, and
 *      optional broker for multi-instance process sharing.
 *   2. **Exec mode** (fallback): `codex exec` / `codex exec resume` for
 *      older Codex CLI versions that lack app-server support.
 *
 * The adapter auto-detects which mode to use at spawn time.
 *
 * Improvements derived from the codex-plugin-cc reference implementation:
 *   - JSON-RPC app-server protocol for persistent connections
 *   - Broker pattern for multi-instance process sharing
 *   - Real-time notification streaming (not batch-after-exit)
 *   - Native thread management (replaces conversation replay)
 *   - Graceful turn interruption via turn/interrupt RPC
 *   - Native context compaction via thread/compact/start
 *   - Structured output schemas for verification/debate
 *   - Reasoning effort control (none → xhigh)
 *   - Cross-platform process tree termination
 *   - Enhanced availability detection
 */

import {
  BaseCliAdapter,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliAttachment,
  CliCapabilities,
  InterruptResult,
  CliMessage,
  CliResponse,
  CliStatus,
  CliToolCall,
  ResumeAttemptResult,
  TurnInterruptCompletion,
} from './base-cli-adapter';
import type { ContextUsage, FileAttachment, InstanceStatus, OutputMessage, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, type ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { buildMessageWithFiles, processAttachments, type ProcessedAttachment } from '../file-handler';
import { getLogger } from '../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getModelCapabilitiesRegistry } from '../../providers/model-capabilities';
import { ActivityStateDetector } from '../../providers/activity-state-detector';
import { CODEX_TIMEOUTS } from '../../../shared/constants/limits';

// App-server imports
import {
  checkAppServerAvailability,
  terminateProcessTree,
} from './codex/app-server-client';
import type { AppServerClient } from './codex/app-server-client';
import type {
  AppServerNotification,
  AppServerRequestParams,
  AppServerResponseResult,
  CodexReasoningEffort,
  ThreadItem,
  TurnCaptureState,
  TurnPhase,
  UserInput,
} from './codex/app-server-types';
import { SERVICE_NAME } from './codex/app-server-types';
import { CodexSessionScanner } from './codex/session-scanner';
import type { ResumeCursor } from '../../session/session-continuity';
import { supportsCodexInlineImage } from './codex/attachments';
import { extractCodexAppServerError, formatCodexAppServerError } from './codex/app-server-errors';
import { CodexHomeManager } from './codex/codex-home-manager';
import { classifyCodexDiagnostic, type CodexDiagnostic } from './codex/exec-diagnostics';
import { parseCodexExecTranscript } from './codex/exec-transcript-parser';
import { extractReasoningSections, mergeReasoningSections, shorten } from './codex/reasoning';

const logger = getLogger('CodexCliAdapter');

// ─── Local Types ────────────────────────────────────────────────────────────

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexExecutionResult {
  code: number | null;
  diagnostics: CodexDiagnostic[];
  raw: string;
  response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
}

interface CodexExecutionState {
  diagnostics: CodexDiagnostic[];
  partialStderr: string;
  partialStdout: string;
  rawStderr: string;
  rawStdout: string;
  threadId?: string;
  /** Keys (category:line) of diagnostics already surfaced in real-time, to avoid spamming the UI during retry loops. */
  emittedDiagnosticKeys: Set<string>;
}

interface CodexConversationEntry {
  content: string;
  role: 'assistant' | 'user';
}

/**
 * Codex CLI specific configuration
 */
export interface CodexCliConfig {
  /** Additional writable directories */
  additionalWritableDirs?: string[];
  /** Approval mode: suggest, auto-edit, or full-auto */
  approvalMode?: CodexApprovalMode;
  /** Run without persisting session files to disk */
  ephemeral?: boolean;
  /** Model to use (gpt-5.5, gpt-5.3-codex, etc.) */
  model?: string;
  /** JSON Schema object for structured output (app-server mode) */
  outputSchema?: Record<string, unknown>;
  /** Path to a JSON schema file describing the final output (exec mode) */
  outputSchemaPath?: string;
  /** TOML MCP server config injected into a temporary CODEX_HOME for this adapter. */
  mcpServersConfigToml?: string;
  /** Reasoning effort level for the model */
  reasoningEffort?: CodexReasoningEffort;
  /** Resume the provided session/thread on the next exec */
  resume?: boolean;
  /** Sandbox mode: read-only, workspace-write, or danger-full-access */
  sandboxMode?: CodexSandboxMode;
  /** Existing Codex session/thread id */
  sessionId?: string;
  /** System prompt to inject into each exec request */
  systemPrompt?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Working directory */
  workingDir?: string;
}

/**
 * Events emitted by CodexCliAdapter (for InstanceManager compatibility)
 */
export interface CodexCliAdapterEvents {
  'context': (usage: ContextUsage) => void;
  'error': (error: Error) => void;
  'exit': (code: number | null, signal: string | null) => void;
  'output': (message: OutputMessage) => void;
  'spawned': (pid: number) => void;
  'status': (status: InstanceStatus) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Inferred-completion delay after final answer + all subagents drain. */
const INFERRED_COMPLETION_MS = 250;

/** Regex to detect verification commands for progress phase reporting. */
const VERIFICATION_CMD_PATTERN = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;

// ─── Error types ────────────────────────────────────────────────────────────

/**
 * Which phase of the exec-mode lifecycle the timeout fired in.
 * - `startup`: first turn after spawn — short budget to surface auth/config hangs fast
 * - `turn`: subsequent turns — long budget for legitimate long-running work
 */
export type CodexExecPhase = 'startup' | 'turn';

/**
 * Error thrown when an exec-mode `codex` child process fails to complete within
 * its per-turn budget. Callers (notably the `sendMessage` retry loop) use
 * `instanceof` to distinguish timeouts from transient errors so they don't
 * compound the wait by retrying a hung process.
 *
 * When the timeout was preceded by network errors from codex's own API layer,
 * `cause` points at the last such diagnostic so the UI can explain *why* we
 * killed the process (connectivity vs. generic hang).
 */
export class CodexTimeoutError extends Error {
  readonly phase: CodexExecPhase;
  readonly timeoutMs: number;
  readonly networkErrorCount: number;
  readonly lastNetworkError: string | null;

  constructor(
    phase: CodexExecPhase,
    timeoutMs: number,
    details?: { networkErrorCount?: number; lastNetworkError?: string | null }
  ) {
    const networkErrorCount = details?.networkErrorCount ?? 0;
    const lastNetworkError = details?.lastNetworkError ?? null;
    const networkSuffix = networkErrorCount > 0
      ? ` — codex reported ${networkErrorCount} network error${networkErrorCount === 1 ? '' : 's'} before going silent`
      : '';
    super(`Codex exec timed out after ${timeoutMs}ms during ${phase}${networkSuffix}`);
    this.name = 'CodexTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
    this.networkErrorCount = networkErrorCount;
    this.lastNetworkError = lastNetworkError;
  }
}

// ─── Adapter ────────────────────────────────────────────────────────────────

/**
 * Codex CLI Adapter - Implementation for OpenAI Codex CLI
 *
 * Supports dual-mode operation: app-server (persistent JSON-RPC) and
 * exec (spawn-per-message) with automatic detection and fallback.
 */
export class CodexCliAdapter extends BaseCliAdapter {
  private static readonly MAX_REPLAY_CHARS_PER_ENTRY = 1200;
  private static readonly MAX_REPLAY_ENTRIES = 16;

  private cliConfig: CodexCliConfig;
  private readonly codexHome = new CodexHomeManager();
  private isSpawned = false;
  /** Running total of tokens spent across all turns (for cost/spend tracking). */
  private cumulativeTokensUsed = 0;
  /** Per-turn token occupancy from the most recent API call (for context bar). */
  private lastTurnTokens = 0;
  /** Whether we've received a thread/tokenUsage/updated notification (accurate source). */
  private hasTokenUsageNotification = false;
  /**
   * Context window size reported by Codex via `thread/tokenUsage/updated`.
   * Authoritative when available — takes precedence over the static registry.
   */
  private codexReportedContextWindow = 0;

  // ─── App-server mode state ────────────────────────────────────────
  /** Whether app-server mode is active (vs exec fallback). */
  private useAppServer = false;
  /** Persistent app-server client (only in app-server mode). */
  private appServerClient: AppServerClient | null = null;
  /** Current thread ID in the app-server (replaces conversation history). */
  private appServerThreadId: string | null = null;
  /** Current turn ID (for interrupt support). */
  private currentTurnId: string | null = null;
  /** Completion proof for the active app-server turn, used by interrupt lifecycle. */
  private currentTurnCompletion: Promise<TurnInterruptCompletion> | null = null;
  /** Whether a turn is currently in progress. */
  private turnInProgress = false;
  /** Whether the system prompt has been sent (app-server mode, first turn only). */
  private systemPromptSent = false;

  // ─── Exec mode state ──────────────────────────────────────────────
  private conversationHistory: CodexConversationEntry[] = [];
  private shouldResumeNextTurn: boolean;
  /**
   * Tracks whether at least one exec-mode turn has completed successfully.
   * The first turn uses a short startup budget (`EXEC_STARTUP_MS`) to fail
   * fast on cold-start hangs; subsequent turns use the longer turn budget
   * (`EXEC_TURN_MS`). Resume sessions also start with the short budget —
   * if auth/config is broken, it'll hang regardless of whether it's a
   * resume or a fresh session.
   */
  private hasCompletedExecTurn = false;

  // ─── Resume cursor state ──────────────────────────────────────────
  private sessionScanner = new CodexSessionScanner();
  private resumeCursor: ResumeCursor | null = null;
  private lastResumeAttemptResult: ResumeAttemptResult | null = null;
  private activityDetector: ActivityStateDetector | null = null;

  constructor(config: CodexCliConfig = {}) {
    const adapterConfig: CliAdapterConfig = {
      command: 'codex',
      args: [],
      cwd: config.workingDir,
      timeout: config.timeout || 300000,
      sessionPersistence: !config.ephemeral,
    };
    super(adapterConfig);

    this.cliConfig = config;
    this.sessionId = config.sessionId || `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.shouldResumeNextTurn = Boolean(this.supportsNativeResume() && config.resume && config.sessionId);
  }

  setActivityDetector(detector: ActivityStateDetector): void {
    this.activityDetector = detector;
  }

  getName(): string {
    return 'codex-cli';
  }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: true,
      codeExecution: true,
      contextWindow: this.resolveContextWindow(),
      outputFormats: ['text', 'json'],
    };
  }

  /**
   * Resolves the context-window size. Prefers the value reported by Codex via
   * `thread/tokenUsage/updated` (authoritative), then falls back to the
   * model-capabilities registry, and finally to `CONTEXT_WINDOWS.CODEX_DEFAULT`.
   */
  private resolveContextWindow(): number {
    if (this.codexReportedContextWindow > 0) {
      return this.codexReportedContextWindow;
    }
    const model = this.cliConfig.model ?? 'default';
    const caps = getModelCapabilitiesRegistry().getCapabilities('codex', model);
    return caps.contextWindow;
  }

  private resolveTurnIdleTimeoutMs(): number {
    const configuredTimeout = this.cliConfig.timeout;
    if (typeof configuredTimeout === 'number' && Number.isFinite(configuredTimeout) && configuredTimeout > 0) {
      return configuredTimeout;
    }
    return CODEX_TIMEOUTS.EXEC_TURN_MS;
  }

  private resolveNotificationIdleTimeoutMs(activeItems: number): number {
    if (activeItems > 0) {
      return this.resolveTurnIdleTimeoutMs();
    }
    return Math.max(
      CODEX_TIMEOUTS.NOTIFICATION_IDLE_MS,
      Math.min(this.resolveTurnIdleTimeoutMs(), CODEX_TIMEOUTS.NOTIFICATION_IDLE_ACTIVE_MS)
    );
  }

  /**
   * Returns runtime capabilities. Note: `supportsNativeCompaction` is dynamic —
   * it reflects the current mode (app-server vs exec) and will be `false` before
   * `spawn()` is called. Consumers should re-check after spawn if needed.
   */
  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: this.supportsNativeResume(),
      supportsForkSession: false,
      // App-server mode supports native compaction via thread/compact/start.
      // This is dynamic — only true after spawn() detects app-server support.
      supportsNativeCompaction: this.useAppServer,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  /**
   * Checks CLI availability and whether app-server mode is supported.
   * Returns extended status with `appServerAvailable` metadata.
   */
  async checkStatus(): Promise<CliStatus> {
    return new Promise((resolve) => {
      const proc = this.spawnProcess(['--version']);
      let output = '';

      proc.stdout?.on('data', (data) => {
        output += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0 || output.includes('codex')) {
          const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
          // Additionally check for app-server subcommand availability
          const appServerAvailable = checkAppServerAvailability();
          resolve({
            available: true,
            version: versionMatch?.[1] || 'unknown',
            path: 'codex',
            authenticated: true,
            metadata: { appServerAvailable },
          });
        } else {
          resolve({
            available: false,
            error: `Codex CLI not found or not configured: ${output}`,
          });
        }
      });

      proc.on('error', (err) => {
        resolve({
          available: false,
          error: `Failed to spawn codex: ${err.message}`,
        });
      });

      setTimeout(() => {
        proc.kill();
        resolve({
          available: false,
          error: 'Timeout checking Codex CLI',
        });
      }, 5000);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Spawn / Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  async spawn(): Promise<number> {
    if (this.isSpawned) {
      throw new Error('Adapter already spawned');
    }

    const status = await this.checkStatus();
    if (!status.available) {
      throw new Error(status.error || 'Codex CLI is unavailable');
    }

    // Decide which mode to use
    const appServerAvailable = Boolean(status.metadata?.['appServerAvailable']);
    if (this.cliConfig.mcpServersConfigToml) {
      this.prepareCodexHome();
    }

    if (appServerAvailable) {
      // App-server mode: persistent JSON-RPC connection
      try {
        await Promise.race([
          this.initAppServerMode(),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('Codex app-server initialization timed out after 30s')),
              CODEX_TIMEOUTS.APP_SERVER_INIT_MS
            )
          ),
        ]);
        this.useAppServer = true;
        logger.info('Codex adapter using app-server mode');
      } catch (err) {
        // Falling back to exec mode silently here is how users ended up
        // waiting 10 minutes for a "Codex CLI timeout" error. Log the
        // specific reason at warn level so post-mortem debugging works.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn('App-server initialization failed, falling back to exec mode', {
          reason,
          isTimeout: reason.includes('timed out'),
        });
        this.useAppServer = false;
        if (!this.config.env?.['CODEX_HOME']) {
          this.prepareCodexHome();
        }
      }
    } else {
      // Exec mode: spawn per message.
      // The WHY is already logged by checkAppServerAvailability() at warn level.
      if (!this.config.env?.['CODEX_HOME']) {
        this.prepareCodexHome();
      }
      logger.info('Codex adapter using exec mode (app-server not available)');
    }

    this.isSpawned = true;
    const fakePid = this.appServerClient
      ? ((this.appServerClient as { getPid?: () => number | undefined }).getPid?.() || Math.floor(Math.random() * 100000) + 10000)
      : Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    return fakePid;
  }

  /**
   * Sends a message and emits events.
   * Routes to app-server or exec mode based on current configuration.
   */
  protected override async sendInputImpl(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.isSpawned) {
      throw new Error('Adapter not spawned - call spawn() first');
    }

    this.emit('status', 'busy' as InstanceStatus);

    try {
      if (this.useAppServer && this.appServerClient) {
        await this.appServerSendMessage(message, attachments);
      } else {
        await this.execSendMessage(message, attachments);
      }

      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      const errText = error instanceof Error ? error.message : String(error);
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Codex error: ${errText}`,
      });

      // In exec mode the child has already exited — there is no persistent
      // state to recover and the next turn will spawn a fresh process. Forcing
      // `status='error'` here triggers the renderer to clear the message queue
      // with a "restart the instance" notice, which is wrong for transient
      // failures (OpenAI HTTP 500 bursts, network blips, etc.). Return to idle
      // so the user can simply retry. App-server mode keeps the stricter
      // behavior because a failed turn there may have broken the persistent
      // thread/client; that path has its own recovery.
      const isRecoverable = !this.useAppServer || this.isRecoverableTurnError(errText);
      this.emit('status', (isRecoverable ? 'idle' : 'error') as InstanceStatus);
      throw error;
    }
  }

  private isRecoverableTurnError(message: string): boolean {
    // Treat transient backend and network errors as recoverable; the thread
    // is almost certainly still alive on the app-server side and a fresh
    // turn can be sent. Auth/model/session errors stay fatal — the instance
    // genuinely needs a restart.
    if (/unauthorized|authentication|forbidden|login required/i.test(message)) return false;
    if (/session not found|thread not found|no matching session/i.test(message)) return false;
    if (/unknown model|model not found|invalid model/i.test(message)) return false;
    return /http 5\d\d|network error|connection (refused|reset|timed out|closed)|dns|tls|handshake|rate limit|timeout|socket hang up|econnreset/i.test(message);
  }

  /**
   * Gracefully interrupts the current turn.
   * - App-server mode: sends `turn/interrupt` RPC (preserves thread state)
   * - Exec mode: SIGINT to the process
   */
  override interrupt(): InterruptResult {
    if (this.useAppServer && this.appServerClient && this.turnInProgress) {
      // Graceful RPC interrupt — preserves the thread for future turns
      if (this.appServerThreadId && this.currentTurnId) {
        const threadId = this.appServerThreadId;
        const turnId = this.currentTurnId;
        const turnCompletion = this.currentTurnCompletion;
        const completion = this.interruptActiveAppServerTurn(threadId, turnId, turnCompletion);
        return { status: 'accepted', turnId, completion };
      }
      return { status: 'no-active-turn', reason: 'Codex app-server turn has not reported a turn id yet' };
    }
    // Fall back to base class SIGINT behavior
    return super.interrupt();
  }

  private async interruptActiveAppServerTurn(
    threadId: string,
    turnId: string,
    turnCompletion: Promise<TurnInterruptCompletion> | null,
  ): Promise<TurnInterruptCompletion> {
    if (!this.appServerClient) {
      return { status: 'rejected', turnId, reason: 'Codex app-server client is not connected' };
    }

    try {
      const result = await this.appServerClient.request('turn/interrupt', {
        threadId,
        turnId,
      });
      if (!result.success) {
        return { status: 'rejected', turnId, reason: 'Codex did not accept turn/interrupt' };
      }

      if (!turnCompletion) {
        return { status: 'accepted', turnId };
      }

      return await turnCompletion;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('Failed to interrupt turn via RPC', { error: reason, turnId });
      return { status: 'rejected', turnId, reason };
    }
  }

  /**
   * Triggers native context compaction (app-server mode only).
   * Sends `thread/compact/start` to reduce context window usage.
   */
  async compactContext(): Promise<boolean> {
    if (!this.useAppServer || !this.appServerClient || !this.appServerThreadId) {
      return false;
    }

    try {
      await this.appServerClient.request('thread/compact/start', {
        threadId: this.appServerThreadId,
      });
      logger.info('Context compacted via app-server', { threadId: this.appServerThreadId });
      return true;
    } catch (err) {
      logger.warn('Context compaction failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  override async terminate(graceful = true): Promise<void> {
    this.isSpawned = false;

    // Close app-server connection
    if (this.appServerClient) {
      try {
        await this.appServerClient.close();
      } catch { /* best effort */ }
      this.appServerClient = null;
    }

    this.cleanupCodexHome();
    await super.terminate(graceful);
  }

  /** Whether app-server mode is currently active. */
  isAppServerMode(): boolean {
    return this.useAppServer;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  App-Server Mode Implementation
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Initializes the persistent app-server connection and starts a thread.
   */
  private async initAppServerMode(): Promise<void> {
    const cwd = this.cliConfig.workingDir || process.cwd();

    // For persistent mode we need to establish a connection and keep the client alive.
    const client = await this.connectAppServer(cwd);

    try {
      const approvalPolicy = this.cliConfig.approvalMode === 'full-auto' ? 'never' : 'never';
      const sandbox = this.mapSandboxMode();

      // === 4-step resume fallback chain ===
      let threadId: string | null = null;
      let resumeSource: ResumeCursor['scanSource'] | null = null;
      const resumeRequested = this.shouldResumeNextTurn;
      this.lastResumeAttemptResult = resumeRequested
        ? {
            source: 'none',
            confirmed: false,
            requestedSessionId: this.sessionId ?? undefined,
            reason: 'Native resume not attempted yet',
          }
        : {
            source: 'none',
            confirmed: true,
            reason: 'Fresh thread requested',
          };

      // Step 1: Resume from persisted cursor (if config.resume and cursor is fresh)
      if (this.shouldResumeNextTurn && this.sessionId) {
        try {
          const requestedSessionId = this.sessionId;
          const resumeResult = await client.request('thread/resume', {
            threadId: requestedSessionId,
            cwd,
            model: this.cliConfig.model || null,
            approvalPolicy,
            sandbox,
          });
          threadId = resumeResult.threadId || resumeResult.thread?.id || null;
          resumeSource = 'native';
          this.lastResumeAttemptResult = {
            source: 'native',
            confirmed: Boolean(threadId),
            requestedSessionId,
            actualSessionId: threadId ?? undefined,
          };
          logger.info('App-server thread resumed from persisted cursor', { threadId });
        } catch (error) {
          if (this.isRecoverableThreadResumeError(error)) {
            logger.warn('Persisted cursor resume failed (recoverable), trying JSONL scan', { error: String(error) });
            this.lastResumeAttemptResult = {
              source: 'native',
              confirmed: false,
              requestedSessionId: this.sessionId ?? undefined,
              reason: error instanceof Error ? error.message : String(error),
            };
          } else {
            throw error; // Non-recoverable: auth, network, rate limit
          }
        }
      }

      // Step 2: Scan filesystem for threadId
      if (!threadId && this.shouldResumeNextTurn) {
        const scanResult = await this.sessionScanner.findSessionForWorkspace(cwd);
        if (scanResult) {
          try {
            const requestedSessionId = scanResult.threadId;
            const resumeResult = await client.request('thread/resume', {
              threadId: requestedSessionId,
              cwd,
              model: this.cliConfig.model || null,
              approvalPolicy,
              sandbox,
            });
            threadId = resumeResult.threadId || resumeResult.thread?.id || null;
            resumeSource = 'jsonl-scan';
            this.lastResumeAttemptResult = {
              source: 'jsonl-scan',
              confirmed: Boolean(threadId),
              requestedSessionId,
              actualSessionId: threadId ?? undefined,
            };
            logger.info('App-server thread resumed from JSONL scan', { threadId, scannedFile: scanResult.sessionFilePath });
          } catch (error) {
            if (this.isRecoverableThreadResumeError(error)) {
              logger.warn('JSONL scan resume failed (recoverable), falling back to fresh start', { error: String(error) });
              this.lastResumeAttemptResult = {
                source: 'jsonl-scan',
                confirmed: false,
                requestedSessionId: scanResult.threadId,
                reason: error instanceof Error ? error.message : String(error),
              };
            } else {
              throw error;
            }
          }
        } else {
          logger.info('No matching Codex session found on filesystem for workspace', { cwd });
          this.lastResumeAttemptResult = {
            source: 'jsonl-scan',
            confirmed: false,
            requestedSessionId: this.sessionId ?? undefined,
            reason: 'No matching Codex session found on filesystem for workspace',
          };
        }
      }

      // Step 3 & 4: Fresh start (replay continuity preamble is handled at a higher level by SessionContinuityManager)
      if (!threadId) {
        const startResult = await client.request('thread/start', {
          cwd,
          model: this.cliConfig.model || null,
          approvalPolicy,
          sandbox,
          serviceName: SERVICE_NAME,
          ephemeral: this.cliConfig.ephemeral ?? false,
          reasoningEffort: this.cliConfig.reasoningEffort || null,
        });
        threadId = startResult.threadId || startResult.thread?.id || null;
        resumeSource = null;
        this.lastResumeAttemptResult = resumeRequested
          ? {
              source: 'fresh-fallback',
              confirmed: false,
              requestedSessionId: this.sessionId ?? undefined,
              actualSessionId: threadId ?? undefined,
              reason: 'Started a fresh Codex thread after native resume was unavailable',
            }
          : {
              source: 'none',
              confirmed: true,
              actualSessionId: threadId ?? undefined,
              reason: 'Started a fresh Codex thread',
            };
        logger.info('App-server thread started fresh', { threadId });
      }

      // Consume resume flag
      this.shouldResumeNextTurn = false;

      // Update resume cursor for persistence by SessionContinuityManager
      if (threadId) {
        this.resumeCursor = {
          provider: 'openai',
          threadId,
          workspacePath: cwd,
          capturedAt: Date.now(),
          scanSource: resumeSource ?? 'native',
        };
      }

      // Only assign after successful thread creation/resume
      this.appServerClient = client;
      this.appServerThreadId = threadId;
      if (threadId) {
        this.sessionId = threadId;
      }

      // Forward app-server process exit to adapter 'exit' event so the
      // instance lifecycle can detect crashes and auto-respawn. Without this,
      // an app-server crash outside of a turn is silently swallowed.
      client.exitPromise.then(() => {
        if (!this.isSpawned) return; // Already terminated gracefully
        const exitError = client.getExitError();
        const code = exitError ? 1 : 0;
        logger.warn('App-server process exited, forwarding to adapter exit event', {
          threadId: this.appServerThreadId,
          hasError: !!exitError,
          error: exitError?.message,
        });
        this.emit('exit', code, null);
      });
    } catch (err) {
      // Thread creation/resume failed — close the client to prevent orphaning
      try {
        await client.close();
      } catch { /* best-effort cleanup */ }
      throw err;
    }
  }

  /**
   * Connects to the app-server, trying broker first then direct.
   * Returns a persistent client that this adapter owns and must close.
   */
  private async connectAppServer(cwd: string): Promise<AppServerClient> {
    const { connectToAppServer } = await import('./codex/app-server-client');
    return connectToAppServer(cwd, this.cliConfig.mcpServersConfigToml
      ? {
          env: { ...getSafeEnvForTrustedProcess(), ...this.config.env },
          disableBroker: true,
        }
      : {});
  }

  /**
   * Starts a fresh Codex thread on the existing app-server client and swaps
   * it in as the active thread. Used for silent mid-session recovery when the
   * previous thread becomes unresolvable server-side (e.g. Codex retains
   * threads for a bounded time and evicts long-idle ones). The user sees no
   * failure — their retry runs against the new thread.
   *
   * The system prompt is re-sent on the first turn against the new thread
   * because the server no longer has the original thread's context.
   */
  private async reopenAppServerThread(): Promise<void> {
    if (!this.appServerClient) {
      throw new Error('Cannot reopen thread: app-server client is not connected');
    }
    const cwd = this.cliConfig.workingDir || process.cwd();
    const approvalPolicy = this.cliConfig.approvalMode === 'full-auto' ? 'never' : 'never';
    const sandbox = this.mapSandboxMode();

    const startResult = await this.appServerClient.request('thread/start', {
      cwd,
      model: this.cliConfig.model || null,
      approvalPolicy,
      sandbox,
      serviceName: SERVICE_NAME,
      ephemeral: this.cliConfig.ephemeral ?? false,
      reasoningEffort: this.cliConfig.reasoningEffort || null,
    });
    const newThreadId = startResult.threadId || startResult.thread?.id || null;
    if (!newThreadId) {
      throw new Error('Thread reopen failed: app-server returned no thread id');
    }

    logger.info('App-server thread reopened after loss', {
      previousThreadId: this.appServerThreadId,
      newThreadId,
    });

    this.appServerThreadId = newThreadId;
    this.sessionId = newThreadId;
    // The new thread has no prior context — the next turn must re-send the
    // system prompt so the model behaves consistently.
    this.systemPromptSent = false;

    // Refresh the persisted cursor so a later app restart resumes against the
    // live thread instead of the dead one.
    this.resumeCursor = {
      provider: 'openai',
      threadId: newThreadId,
      workspacePath: cwd,
      capturedAt: Date.now(),
      scanSource: 'native',
    };
  }

  /**
   * Sends a message via the app-server with silent recovery from thread loss.
   *
   * If Codex reports the thread is gone (it evicts inactive threads after
   * some interval), we transparently reopen a fresh thread and retry the
   * same message once. The user sees their message succeed. A second failure
   * — or any non-thread-loss error — propagates to the caller so the outer
   * `sendInput` catch can classify and emit the appropriate status.
   */
  private async appServerSendMessage(message: string, attachments?: FileAttachment[]): Promise<void> {
    try {
      await this.appServerSendMessageInner(message, attachments);
    } catch (err) {
      if (!this.isRecoverableThreadResumeError(err)) {
        throw err;
      }
      logger.warn('Codex app-server thread lost mid-turn, reopening and retrying', {
        previousThreadId: this.appServerThreadId,
        cause: err instanceof Error ? err.message : String(err),
      });
      await this.reopenAppServerThread();
      await this.appServerSendMessageInner(message, attachments);
    }
  }

  /**
   * Internal implementation of a single turn against the current app-server
   * thread. Does not retry on thread loss — that is handled by the outer
   * `appServerSendMessage` wrapper.
   */
  private async appServerSendMessageInner(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.appServerClient || !this.appServerThreadId) {
      throw new Error('App-server not initialized');
    }

    // Reset per-turn flag so the fallback path works if this turn doesn't
    // receive a thread/tokenUsage/updated notification.
    this.hasTokenUsageNotification = false;

    // App-server turns accept multimodal inputs. Keep supported images as
    // `localImage` items and only fall back to file references for everything
    // else so vision-capable Codex models still receive the original pixels.
    const preparedAttachments = attachments && attachments.length > 0
      ? await this.prepareAttachmentsForAppServer(message, attachments)
      : { input: [], text: message };
    let content = preparedAttachments.text;

    // Include system prompt on the very first turn only.
    // Track via a dedicated flag — currentTurnId is cleared after every turn.
    if (!this.systemPromptSent && this.cliConfig.systemPrompt?.trim()) {
      const prompt = this.cliConfig.systemPrompt.trim();
      if (prompt.length <= CodexCliAdapter.MAX_SYSTEM_PROMPT_CHARS) {
        content = `[SYSTEM INSTRUCTIONS]\n${prompt}\n[/SYSTEM INSTRUCTIONS]\n\n${content}`;
      }
      this.systemPromptSent = true;
    }

    // Start the turn and capture notifications
    const input: UserInput[] = [];
    const text = content.trim();
    if (text) {
      input.push({ type: 'text', text, text_elements: [] });
    }
    input.push(...preparedAttachments.input);

    if (input.length === 0) {
      throw new Error('Cannot send empty app-server turn input');
    }

    const turnState = await this.captureTurn(input);

    // Check for failed turns (e.g., context overflow, API errors).
    // Codex reports these as turn/completed with status: "failed".
    const turnStatus = turnState.finalTurn?.status;
    if (turnStatus === 'failed' || turnState.error) {
      const finalTurnError = turnState.finalTurn?.error !== undefined && turnState.finalTurn.error !== null
        ? formatCodexAppServerError(extractCodexAppServerError({ error: turnState.finalTurn.error }))
        : undefined;
      const capturedError = turnState.error instanceof Error
        ? turnState.error.message
        : (typeof turnState.error === 'string' ? turnState.error : undefined);
      const errorMsg = finalTurnError ?? capturedError ?? 'Codex turn failed';
      throw new Error(errorMsg);
    }

    // Emit the final response
    const responseContent = turnState.lastAgentMessage || '';
    const toolCalls = this.buildToolCallsFromTurnState(turnState);

    if (responseContent || toolCalls.length > 0) {
      const extracted = extractThinkingContent(responseContent);

      // Merge thinking from two sources:
      // 1. Structured reasoning items (captured via item/completed type:reasoning)
      // 2. Heuristic extraction from agent message text
      const allThinking: ThinkingContent[] = [];

      // Structured reasoning items take priority — they're the model's actual
      // chain-of-thought, already deduplicated in state.reasoningSummary.
      if (turnState.reasoningSummary.length > 0) {
        allThinking.push({
          id: generateId(),
          content: turnState.reasoningSummary.join('\n\n'),
          format: 'structured',
          timestamp: Date.now(),
        });
      }

      // Also include any thinking extracted from the agent message text itself
      for (const block of extracted.thinking) {
        allThinking.push({
          id: block.id,
          content: block.content,
          format: block.format,
          timestamp: block.timestamp || Date.now(),
        });
      }

      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: extracted.response,
        metadata: turnState.turnId ? { turnId: turnState.turnId } : undefined,
        thinking: allThinking.length > 0 ? allThinking : undefined,
      });
    }

    // Context tracking: prefer thread/tokenUsage/updated notifications (accurate
    // per-call data with last/total breakdown). Only fall back to turn/completed
    // usage when the notification wasn't received (e.g. older Codex versions).
    // turn/completed usage contains AGGREGATE input_tokens across all internal
    // agentic sub-calls, NOT actual context window occupancy.
    if (turnState.finalTurn?.usage) {
      const usage = turnState.finalTurn.usage;
      const inputTokens = usage.input_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const turnTokens = inputTokens + outputTokens;

      if (!this.hasTokenUsageNotification) {
        // No accurate notification received — aggregate turn tokens are NOT
        // context-window occupancy (they sum across all internal sub-calls
        // and routinely exceed the context window after a single complex
        // turn). Use the last known good occupancy if we have one; otherwise
        // emit 0 with isEstimated:true rather than clamping the aggregate to
        // 100% of the context window (which would falsely show a full bar).
        const contextWindow = this.resolveContextWindow();
        this.cumulativeTokensUsed += turnTokens;

        if (this.lastTurnTokens > 0) {
          // Re-emit the last known good occupancy (from a previous
          // thread/tokenUsage/updated notification) with updated spend.
          this.emit('context', {
            used: this.lastTurnTokens,
            total: contextWindow,
            percentage: contextWindow > 0 ? Math.min((this.lastTurnTokens / contextWindow) * 100, 100) : 0,
            cumulativeTokens: this.cumulativeTokensUsed,
          });
        } else {
          // No prior occupancy data — we genuinely don't know occupancy.
          // Emit 0 with isEstimated:true and surface lifetime spend via
          // cumulativeTokens. Do NOT cache this in lastTurnTokens, so the
          // next real notification can populate it cleanly.
          this.emit('context', {
            used: 0,
            total: contextWindow,
            percentage: 0,
            cumulativeTokens: this.cumulativeTokensUsed,
            isEstimated: true,
          });
        }
      } else {
        // Accurate notification was already emitted — just update cumulative
        // spend for cost tracking if the notification didn't cover it.
        if (this.cumulativeTokensUsed === 0) {
          this.cumulativeTokensUsed += turnTokens;
        }
      }
    }

    // Build and emit the complete response
    const response: CliResponse = {
      id: this.generateResponseId(),
      content: turnState.lastAgentMessage || '',
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: turnState.finalTurn?.usage ? {
        inputTokens: turnState.finalTurn.usage.input_tokens || 0,
        outputTokens: turnState.finalTurn.usage.output_tokens || 0,
        totalTokens: (turnState.finalTurn.usage.input_tokens || 0) + (turnState.finalTurn.usage.output_tokens || 0),
      } : undefined,
    };
    this.emit('complete', response);
  }

  /**
   * Checks whether a notification belongs to the current turn.
   * Notifications from unknown threads or from turns we're not tracking
   * are considered foreign and should be routed to the previous handler.
   *
   * Ported from codex-plugin-cc's `belongsToTurn()`.
   */
  private belongsToTurn(state: TurnCaptureState, notification: AppServerNotification): boolean {
    const messageThreadId = notification.params['threadId'] as string | undefined;
    if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
      return false;
    }
    const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
    // Extract turn ID from notification (can be in params.turnId or params.turn.id)
    const messageTurnId = (notification.params['turnId'] as string | undefined)
      || (notification.params['turn'] && typeof notification.params['turn'] === 'object'
        ? (notification.params['turn'] as Record<string, unknown>)['id'] as string | undefined
        : undefined)
      || null;
    // If either side is unknown, assume it belongs (safe fallback)
    return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
  }

  /**
   * Captures a complete turn from the app-server, routing notifications
   * to adapter events in real-time.
   *
   * This is the core streaming mechanism, modeled after the codex-plugin-cc
   * `captureTurn()` pattern. Includes multi-turn notification routing:
   * notifications from other turns are forwarded to the previous handler.
   */
  private async captureTurn(input: UserInput[]): Promise<TurnCaptureState> {
    const client = this.appServerClient!;
    const threadId = this.appServerThreadId!;

    // Build turn capture state
    const state = this.createTurnCaptureState(threadId);
    const turnCompletion = state.completion
      .then((completedState) => this.toTurnInterruptCompletion(completedState))
      .catch((err) => ({
        status: 'rejected' as const,
        turnId: state.turnId ?? undefined,
        reason: err instanceof Error ? err.message : String(err),
      }));
    this.currentTurnCompletion = turnCompletion;

    // Install notification handler for real-time event routing.
    // thread/started and thread/name/updated always apply to this turn.
    // Other notifications are checked against belongsToTurn() — foreign
    // notifications are forwarded to the previous handler.
    const previousHandler = client.notificationHandler;

    // Notification idle watchdog — detects stalled turns where no notifications
    // arrive for an extended period (process alive but unresponsive).
    //
    // Codex's app-server JSON-RPC emits notifications at item boundaries only
    // (item/started, item/completed) — there are no sub-item deltas. A single
    // item (long reasoning block, long-running shell command, mcp call) can
    // legitimately take minutes with zero notifications in between. We use a
    // generous timeout while items are in flight and tighten it once the turn
    // is idle between items, so genuine hangs still surface quickly.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let activeItems = 0;
    const armIdleWatchdog = () => {
      if (idleTimer) clearTimeout(idleTimer);
      const timeoutMs = this.resolveNotificationIdleTimeoutMs(activeItems);
      idleTimer = setTimeout(() => {
        if (!state.completed) {
          state.rejectCompletion(
            new Error(`Codex turn stalled: no notifications received for ${timeoutMs}ms`)
          );
        }
      }, timeoutMs);
      idleTimer.unref();
    };

    client.setNotificationHandler((notification: AppServerNotification) => {
      // Track item lifecycle so the watchdog uses the right timeout.
      // Update the counter BEFORE arming so we pick the correct window.
      if (notification.method === 'item/started') {
        activeItems += 1;
      } else if (notification.method === 'item/completed') {
        activeItems = Math.max(0, activeItems - 1);
      }
      armIdleWatchdog();

      // Signal liveness to StuckProcessDetector on every notification.
      // Only a subset of notifications (command_execution items) produce
      // adapter `output` events — non-command tool items (mcp calls,
      // custom tools, reasoning blocks) would otherwise let the 120s soft
      // warning fire even though codex is actively streaming work.
      this.emit('heartbeat');

      // Thread-level notifications always apply
      if (notification.method === 'thread/started' || notification.method === 'thread/name/updated') {
        this.handleTurnNotification(state, notification);
        return;
      }
      // Buffer if we don't have a turn ID yet
      if (!state.turnId) {
        state.bufferedNotifications.push(notification);
        return;
      }
      // Route foreign notifications to the previous handler
      if (!this.belongsToTurn(state, notification)) {
        if (previousHandler) {
          previousHandler(notification);
        }
        return;
      }
      this.handleTurnNotification(state, notification);
    });

    try {
      // Start the turn
      this.turnInProgress = true;
      const turnParams: Record<string, unknown> = {
        threadId,
        input,
      };

      // Add structured output schema if configured
      if (this.cliConfig.outputSchema) {
        turnParams['outputSchema'] = this.cliConfig.outputSchema;
      }

      // Add reasoning effort if configured
      if (this.cliConfig.reasoningEffort) {
        turnParams['reasoningEffort'] = this.cliConfig.reasoningEffort;
      }

      // Arm the idle watchdog BEFORE sending turn/start.  `turn/start` has
      // no per-RPC timeout (see app-server-client.ts#resolveDefaultTimeout —
      // it's intentionally long-running because the server streams work via
      // notifications).  If the app-server hangs without emitting any
      // notifications (seen with codex 0.97.0 on cold start, and possible
      // whenever auth/network/backend is wedged), the watchdog fires after
      // NOTIFICATION_IDLE_MS and rejects state.completion — otherwise the
      // caller would block forever and the UI would show "Processing..."
      // indefinitely.
      armIdleWatchdog();

      // Race turn/start against the watchdog (via state.completion
      // rejection) and process exit, so a hung turn/start surfaces as an
      // error instead of blocking indefinitely.  state.completion.catch is
      // used (not Promise.race directly on state.completion) so that a
      // legitimate synchronous turn/completed arriving during turn/start
      // doesn't short-circuit the race before we've captured the turn id.
      const turnResult = await Promise.race<AppServerResponseResult<'turn/start'>>([
        client.request('turn/start', turnParams as unknown as AppServerRequestParams<'turn/start'>),
        new Promise<never>((_, reject) => {
          state.completion.catch(reject);
        }),
        client.exitPromise.then(() => {
          throw new Error('codex app-server exited unexpectedly during turn/start');
        }) as Promise<never>,
      ]);
      this.currentTurnId = turnResult.turn?.id || null;

      if (this.currentTurnId) {
        state.threadTurnIds.set(threadId, this.currentTurnId);
        state.turnId = this.currentTurnId;
      }

      // Replay buffered notifications — route foreign ones to previousHandler
      for (const buffered of state.bufferedNotifications) {
        if (this.belongsToTurn(state, buffered)) {
          this.handleTurnNotification(state, buffered);
        } else if (previousHandler) {
          previousHandler(buffered);
        }
      }
      state.bufferedNotifications.length = 0;

      // If the turn completed synchronously
      if (turnResult.turn?.status && turnResult.turn.status !== 'inProgress') {
        this.completeTurn(state, turnResult.turn);
      }

      // Re-arm the watchdog to absorb any window consumed during turn/start.
      // In normal flow notifications already reset it; this keeps behavior
      // correct when turn/start returns before any notification arrives.
      armIdleWatchdog();

      // Wait for completion. Two termination conditions:
      //   1. state.completion — turn/completed notification or idle watchdog fires
      //   2. exitPromise — codex app-server process died mid-turn
      //
      // No absolute turn-duration ceiling: a legitimate turn (e.g. many tool
      // calls) may run for tens of minutes. The idle watchdog
      // (NOTIFICATION_IDLE_ACTIVE_MS while items are in flight,
      // NOTIFICATION_IDLE_MS when idle between items) is the single source of
      // truth for hang detection — it resets on every notification, so active
      // work keeps the turn alive indefinitely.
      const completionOrCrash = Promise.race([
        state.completion,
        client.exitPromise.then(() => {
          if (!state.completed) {
            throw new Error('codex app-server exited unexpectedly during turn');
          }
          return state;
        }),
      ]);

      return await completionOrCrash;
    } finally {
      this.turnInProgress = false;
      this.currentTurnId = null;
      if (this.currentTurnCompletion === turnCompletion) {
        this.currentTurnCompletion = null;
      }
      // Clear all timers to prevent leaks
      if (idleTimer) clearTimeout(idleTimer);
      if (state.completionTimer) {
        clearTimeout(state.completionTimer);
      }
      client.setNotificationHandler(previousHandler);
    }
  }

  private toTurnInterruptCompletion(state: TurnCaptureState): TurnInterruptCompletion {
    const finalStatus = state.finalTurn?.status;
    const reason = state.error instanceof Error
      ? state.error.message
      : typeof state.error === 'string'
        ? state.error
        : state.finalTurn?.error !== undefined && state.finalTurn.error !== null
          ? formatCodexAppServerError(extractCodexAppServerError({ error: state.finalTurn.error }))
          : undefined;

    if (finalStatus === 'interrupted') {
      return { status: 'interrupted', turnId: state.turnId ?? undefined, reason };
    }

    if (finalStatus === 'completed') {
      return { status: 'completed', turnId: state.turnId ?? undefined, reason };
    }

    if (finalStatus === 'failed') {
      return { status: 'rejected', turnId: state.turnId ?? undefined, reason: reason ?? 'Codex turn failed' };
    }

    return {
      status: state.completed ? 'completed' : 'unknown',
      turnId: state.turnId ?? undefined,
      reason,
    };
  }

  /**
   * Handles a single notification from the app-server during a turn.
   * Emits real-time events to the adapter and updates turn state.
   */
  private handleTurnNotification(state: TurnCaptureState, notification: AppServerNotification): void {
    // Drop notifications that arrive after the turn has already completed.
    // This prevents orphaned output events from violating the event ordering
    // contract (all output must arrive before 'complete').
    if (state.completed) {
      return;
    }

    const { method, params } = notification;

    // Record native activity from structured events
    if (this.activityDetector) {
      if (method === 'item/started' || method === 'item/completed' || method === 'turn/started') {
        this.activityDetector.recordActivityEntry({
          ts: Date.now(),
          state: 'active',
          source: 'native',
          provider: 'openai',
        }).catch((error: unknown) => {
          logger.debug('Failed to record Codex native activity', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    switch (method) {
      case 'thread/started': {
        // Handle both flat (params.threadId) and nested (params.thread.id) formats
        const threadObj = params['thread'] as Record<string, unknown> | undefined;
        const tId = (threadObj?.['id'] as string) || params['threadId'] as string | undefined;
        if (tId) {
          state.threadIds.add(tId);
          // Extract label from multiple sources (matches codex-plugin-cc)
          const label = (threadObj?.['name'] as string)
            || (params['name'] as string)
            || (threadObj?.['agentNickname'] as string)
            || (threadObj?.['agentRole'] as string)
            || (params['label'] as string)
            || tId;
          state.threadLabels.set(tId, label);
        }
        break;
      }

      case 'thread/name/updated': {
        const tId = params['threadId'] as string | undefined;
        const name = (params['threadName'] as string) || (params['name'] as string) || undefined;
        if (tId && name) {
          state.threadLabels.set(tId, name);
        }
        break;
      }

      case 'turn/started': {
        const turnId = params['turn'] && typeof params['turn'] === 'object'
          ? (params['turn'] as Record<string, unknown>)['id'] as string | undefined
          : undefined;
        const tId = params['threadId'] as string | undefined;
        if (turnId && tId) {
          state.threadTurnIds.set(tId, turnId);
          // Track subagent turns
          if (tId !== state.threadId) {
            state.activeSubagentTurns.add(turnId);
          }
        }
        break;
      }

      case 'item/started': {
        const item = params['item'] as ThreadItem | undefined;
        const threadId = params['threadId'] as string | undefined;
        if (!item) break;

        // Track collaboration lifecycle (started phase)
        if (item.type === 'collabAgentToolCall') {
          if (!threadId || threadId === state.threadId) {
            if (item.id) {
              state.pendingCollaborations.add(item.id);
            }
          }
          // Auto-register receiver threads for subagent tracking
          for (const receiverThreadId of item.receiverThreadIds ?? []) {
            if (receiverThreadId) {
              state.threadIds.add(receiverThreadId);
              if (!state.threadLabels.has(receiverThreadId)) {
                state.threadLabels.set(receiverThreadId, receiverThreadId);
              }
            }
          }
        }

        // Emit real-time tool_use events for various item types
        if (item.type === 'command_execution' && item.command) {
          const phase: TurnPhase = VERIFICATION_CMD_PATTERN.test(item.command)
            ? 'verifying'
            : 'running';
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running command: ${shorten(item.command, 96)}`,
            metadata: { streaming: true, phase },
          });
        } else if (item.type === 'file_change') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Editing file: ${item.path || 'unknown'}`,
            metadata: { streaming: true, phase: 'editing' as TurnPhase },
          });
        } else if (item.type === 'enteredReviewMode') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Reviewer started: ${item.review || 'code review'}`,
            metadata: { streaming: true, phase: 'reviewing' as TurnPhase },
          });
        } else if (item.type === 'mcpToolCall') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Calling ${item.server || 'mcp'}/${item.tool || item.toolName || 'unknown'}`,
            metadata: { streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'dynamicToolCall') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running tool: ${item.tool || item.toolName || 'unknown'}`,
            metadata: { streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'collabAgentToolCall') {
          const subagentLabels = (item.receiverThreadIds ?? [])
            .map((tid) => state.threadLabels.get(tid) ?? tid);
          const summary = subagentLabels.length > 0
            ? `Starting subagent ${subagentLabels.join(', ')} via ${item.tool || 'collaboration'}`
            : `Starting collaboration tool: ${item.tool || 'unknown'}`;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: summary,
            metadata: { streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'webSearch') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Searching: ${shorten(item.query, 96)}`,
            metadata: { streaming: true, phase: 'investigating' as TurnPhase },
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params['item'] as ThreadItem | undefined;
        const threadId = params['threadId'] as string | undefined;
        if (!item) break;

        // ── Collaboration lifecycle (completed phase) ──
        if (item.type === 'collabAgentToolCall') {
          if (!threadId || threadId === state.threadId) {
            if (item.id) {
              state.pendingCollaborations.delete(item.id);
              this.scheduleInferredCompletion(state);
            }
          }
          // Auto-register receiver threads even on completion
          for (const receiverThreadId of item.receiverThreadIds ?? []) {
            if (receiverThreadId) {
              state.threadIds.add(receiverThreadId);
            }
          }
          const subagentLabels = (item.receiverThreadIds ?? [])
            .map((tid) => state.threadLabels.get(tid) ?? tid);
          const summary = subagentLabels.length > 0
            ? `Subagent ${subagentLabels.join(', ')} ${item.status || 'completed'}`
            : `Collaboration tool ${item.tool || 'unknown'} ${item.status || 'completed'}`;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: summary,
            metadata: { is_error: false },
          });
        }

        // ── Command execution ──
        if (item.type === 'command_execution') {
          state.commandExecutions.push(item);
          if (item.aggregated_output) {
            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'tool_result',
              content: item.aggregated_output,
              metadata: {
                command: item.command,
                exitCode: item.exit_code,
                is_error: item.exit_code !== 0,
              },
            });
          }
        }

        // ── Agent message ──
        // Handle both 'agent_message' (our convention) and 'agentMessage' (codex protocol)
        if (item.type === 'agent_message' || item.type === 'agentMessage') {
          const text = item.text || item.content
            || (item.message && typeof item.message === 'object' ? item.message.content : undefined)
            || '';
          if (text) {
            const itemPhase = item.phase || (params['phase'] as string | undefined) || null;
            state.messages.push({ lifecycle: 'completed', phase: itemPhase, text });

            // Only update lastAgentMessage for root thread messages
            if (!threadId || threadId === state.threadId) {
              state.lastAgentMessage = text;
              if (itemPhase === 'final_answer') {
                state.finalAnswerSeen = true;
                this.scheduleInferredCompletion(state);
              }
            }
          }
        }

        // ── File change ──
        if (item.type === 'file_change' || item.type === 'fileChange') {
          state.fileChanges.push(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `File ${item.changeType || 'modified'}: ${item.path || 'unknown'}`,
            metadata: { path: item.path, changeType: item.changeType, is_error: false },
          });
        }

        // ── Reasoning (with deduplication) ──
        if (item.type === 'reasoning') {
          // Extract from heterogeneous summary field (string, array, or nested object)
          const nextSections = extractReasoningSections(item.summary ?? item.summaryText);
          if (nextSections.length > 0) {
            state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
          }
        }

        // ── Review mode exited ──
        if (item.type === 'exitedReviewMode') {
          state.reviewText = item.review ?? '';
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: item.review || 'Review completed',
            metadata: { is_error: false, phase: 'reviewing' },
          });
        }

        // ── MCP tool call completed ──
        if (item.type === 'mcpToolCall') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Tool ${item.server || 'mcp'}/${item.tool || item.toolName || 'unknown'} ${item.status || 'completed'}`,
            metadata: { is_error: false, phase: 'investigating' },
          });
        }

        // ── Dynamic tool call completed ──
        if (item.type === 'dynamicToolCall') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Tool ${item.tool || item.toolName || 'unknown'} ${item.status || 'completed'}`,
            metadata: { is_error: false, phase: 'investigating' },
          });
        }

        // ── Web search completed ──
        if (item.type === 'webSearch') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Search completed: ${shorten(item.query, 96)}`,
            metadata: { is_error: false, phase: 'investigating' },
          });
        }

        break;
      }

      case 'turn/completed': {
        const turn = params['turn'] as TurnCaptureState['finalTurn'] | undefined;
        const tId = params['threadId'] as string | undefined;

        // If this is a subagent turn completing, just remove from tracking
        if (tId && tId !== state.threadId) {
          const turnId = turn?.id;
          if (turnId) {
            state.activeSubagentTurns.delete(turnId);
          }
          // Check if we should infer completion
          this.scheduleInferredCompletion(state);
          break;
        }

        // Root thread turn completed
        this.completeTurn(state, turn || null);
        break;
      }

      case 'thread/tokenUsage/updated': {
        // Codex app-server provides accurate per-turn and cumulative token data.
        // Structure: { tokenUsage: { total: {...}, last: {...}, modelContextWindow: N } }
        // Field names may be camelCase or snake_case depending on Codex version.
        const tokenUsage = (params['tokenUsage'] ?? params['token_usage']) as Record<string, unknown> | undefined;
        if (!tokenUsage) break;

        const last = (tokenUsage['last'] ?? tokenUsage['last_token_usage']) as Record<string, unknown> | undefined;
        const total = (tokenUsage['total'] ?? tokenUsage['total_token_usage']) as Record<string, unknown> | undefined;

        // last.totalTokens = actual context window occupancy for the most recent API call.
        // Guard against NaN from malformed fields (empty strings, objects, etc.).
        const lastTotal = Number(last?.['totalTokens'] ?? last?.['total_tokens'] ?? 0) || 0;
        const cumulativeTotal = Number(total?.['totalTokens'] ?? total?.['total_tokens'] ?? 0) || 0;

        // Use model_context_window from Codex when available (authoritative source)
        // Persist Codex-reported context window for future resolveContextWindow() calls
        const codexContextWindow = Number(tokenUsage['modelContextWindow'] ?? tokenUsage['model_context_window'] ?? 0) || 0;
        if (codexContextWindow > 0) {
          this.codexReportedContextWindow = codexContextWindow;
        }
        const contextWindow = codexContextWindow > 0 ? codexContextWindow : this.resolveContextWindow();

        // Prefer last.totalTokens (actual context-window occupancy for the most
        // recent API call). Do NOT fall back to cumulativeTotal — that's lifetime
        // spend, not occupancy, and would always inflate the context bar.
        const hasAccurateOccupancy = lastTotal > 0;
        const used = hasAccurateOccupancy ? lastTotal : this.lastTurnTokens;
        if (hasAccurateOccupancy) {
          this.lastTurnTokens = lastTotal;
        }
        if (cumulativeTotal > 0) {
          this.cumulativeTokensUsed = cumulativeTotal;
        }
        this.hasTokenUsageNotification = true;

        this.emit('context', {
          used,
          total: contextWindow,
          percentage: Math.min((used / contextWindow) * 100, 100),
          cumulativeTokens: this.cumulativeTokensUsed,
          // If we don't have per-call occupancy AND no prior occupancy, flag it
          ...(!hasAccurateOccupancy && used === 0 ? { isEstimated: true } : {}),
        });
        break;
      }

      case 'error': {
        const errorDetails = extractCodexAppServerError(params);
        // Include codex_error_info in the error message so upstream overflow detection
        // can match it (e.g., "ContextWindowExceeded" matches /context.?window.?exceeded/i).
        const fullMessage = formatCodexAppServerError(errorDetails);
        state.error = new Error(fullMessage);
        logger.warn('Error notification from app-server', {
          additionalDetails: errorDetails.additionalDetails,
          codexErrorInfo: errorDetails.codexErrorInfo,
          error: errorDetails.message,
          willRetry: errorDetails.willRetry,
        });
        break;
      }

      case 'thread/compacted': {
        // Codex auto-compacted the thread. Emit a system message and refresh context usage.
        logger.info('Thread compacted by Codex app-server', { threadId: state.threadId });
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: 'Codex automatically compacted the conversation to free context space.',
          metadata: { threadCompacted: true },
        });
        // Context usage will be updated by the next thread/tokenUsage/updated notification.
        break;
      }

      // ── Streaming deltas ──
      // Codex app-server emits fine-grained deltas during reasoning and
      // agent message generation. These notifications prove the turn is
      // alive even when no tool_use/tool_result output events are emitted.
      // Without a heartbeat here, the stuck-process detector fires during
      // long reasoning phases (>120 s with no visible output).
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta': {
        this.emit('heartbeat');
        break;
      }

      default:
        break;
    }
  }

  /**
   * Schedules inferred completion for cases where `turn/completed` may not fire.
   * This handles multi-agent scenarios where the root turn finishes after
   * a final_answer + all subagent turns drain.
   */
  private scheduleInferredCompletion(state: TurnCaptureState): void {
    if (state.completed || !state.finalAnswerSeen) return;
    if (state.activeSubagentTurns.size > 0 || state.pendingCollaborations.size > 0) return;

    // Clear any existing timer
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
    }

    state.completionTimer = setTimeout(() => {
      if (!state.completed) {
        logger.debug('Inferred turn completion after final answer + subagent drain');
        this.completeTurn(state, null);
      }
    }, INFERRED_COMPLETION_MS);
    // Don't let this timer prevent clean process exit
    if (state.completionTimer && typeof state.completionTimer === 'object' && 'unref' in state.completionTimer) {
      (state.completionTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Marks the turn as completed and resolves the completion promise.
   */
  private completeTurn(state: TurnCaptureState, turn: TurnCaptureState['finalTurn']): void {
    if (state.completed) return;
    state.completed = true;
    state.finalTurn = turn;

    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = null;
    }

    state.resolveCompletion(state);
  }

  /**
   * Creates a fresh TurnCaptureState for accumulating streaming notifications.
   */
  private createTurnCaptureState(threadId: string): TurnCaptureState {
    let resolveCompletion!: (state: TurnCaptureState) => void;
    let rejectCompletion!: (error: unknown) => void;
    const completion = new Promise<TurnCaptureState>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    return {
      threadId,
      threadIds: new Set([threadId]),
      threadTurnIds: new Map(),
      threadLabels: new Map(),
      turnId: null,
      bufferedNotifications: [],
      completion,
      resolveCompletion,
      rejectCompletion,
      finalTurn: null,
      completed: false,
      finalAnswerSeen: false,
      pendingCollaborations: new Set(),
      activeSubagentTurns: new Set(),
      completionTimer: null,
      lastAgentMessage: '',
      reviewText: '',
      reasoningSummary: [],
      error: null,
      messages: [],
      fileChanges: [],
      commandExecutions: [],
      onProgress: null,
    };
  }

  /**
   * Converts TurnCaptureState command executions and file changes into CliToolCalls.
   */
  private buildToolCallsFromTurnState(state: TurnCaptureState): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];

    for (const cmd of state.commandExecutions) {
      toolCalls.push({
        id: cmd.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'command_execution',
        arguments: {
          command: cmd.command,
          exitCode: cmd.exit_code,
          status: cmd.status,
        },
        result: cmd.aggregated_output || undefined,
      });
    }

    for (const fc of state.fileChanges) {
      toolCalls.push({
        id: fc.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'file_change',
        arguments: {
          path: fc.path,
          changeType: fc.changeType,
        },
        result: fc.description || undefined,
      });
    }

    return toolCalls;
  }

  /**
   * Maps the adapter's sandbox mode to the app-server format.
   */
  private mapSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
    if (this.cliConfig.approvalMode === 'full-auto') return 'danger-full-access';
    return this.cliConfig.sandboxMode || 'read-only';
  }

  private async prepareAttachmentsForAppServer(
    message: string,
    attachments: FileAttachment[]
  ): Promise<{ input: UserInput[]; text: string }> {
    if (attachments.length === 0) {
      return { input: [], text: message };
    }

    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const processed = await processAttachments(attachments, this.sessionId || generateId(), workingDirectory);
    if (processed.length === 0) {
      return { input: [], text: message };
    }

    const imageInputs: UserInput[] = processed
      .filter((attachment) => attachment.isImage && supportsCodexInlineImage(attachment.mimeType))
      .map((attachment) => ({
        type: 'localImage',
        path: attachment.filePath,
      }));

    const fileAttachments = processed.filter(
      (attachment) => !attachment.isImage || !supportsCodexInlineImage(attachment.mimeType)
    );

    return {
      input: imageInputs,
      text: fileAttachments.length > 0
        ? buildMessageWithFiles(message, fileAttachments)
        : message,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Exec Mode Implementation (Fallback)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Sends a message via `codex exec` with silent recovery from thread loss.
   *
   * When `codex exec resume <threadId>` fails because the thread has been
   * evicted server-side, we clear the stale session id (so the retry uses a
   * fresh `codex exec` spawn) and run the turn again. The user sees their
   * message succeed. This mirrors the app-server reopen logic but is simpler
   * because exec mode has no persistent client state to rebuild.
   */
  private async execSendMessage(message: string, attachments?: FileAttachment[]): Promise<void> {
    try {
      await this.execSendMessageInner(message, attachments);
    } catch (err) {
      if (!this.isRecoverableThreadResumeError(err)) {
        throw err;
      }
      const previousSessionId = this.sessionId;
      logger.warn('Codex exec resume failed, retrying with a fresh session', {
        previousSessionId,
        cause: err instanceof Error ? err.message : String(err),
      });

      // Clear resume state so buildArgs() picks `codex exec` (not `exec resume`).
      // A fresh placeholder keeps `sessionId` non-null for downstream consumers
      // until the new turn captures a real threadId from codex stdout.
      this.sessionId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.shouldResumeNextTurn = false;
      this.resumeCursor = null;
      // System prompt + conversation history are re-sent on a fresh thread.
      this.systemPromptSent = false;

      await this.execSendMessageInner(message, attachments);
    }
  }

  /**
   * Internal implementation of a single exec-mode turn. Does not retry on
   * thread loss — handled by the outer `execSendMessage` wrapper.
   */
  private async execSendMessageInner(message: string, attachments?: FileAttachment[]): Promise<void> {
    const cliMessage: CliMessage = {
      role: 'user',
      content: message,
      attachments: attachments?.map((attachment) => ({
        type: attachment.type.startsWith('image/') ? 'image' : 'file',
        content: attachment.data,
        mimeType: attachment.type,
        name: attachment.name,
      })),
    };

    const response = await this.sendMessage(cliMessage) as CliResponse & {
      metadata?: {
        diagnostics?: CodexDiagnostic[];
      };
      thinking?: ThinkingBlock[];
    };

    this.emitDiagnostics(response.metadata?.diagnostics);

    if (response.toolCalls) {
      for (const tool of response.toolCalls) {
        this.emit('output', {
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_use',
          content: tool.name === 'command_execution' && typeof tool.arguments['command'] === 'string'
            ? `Running command: ${tool.arguments['command'] as string}`
            : `Using tool: ${tool.name}`,
          metadata: { ...tool } as Record<string, unknown>,
        });

        if (typeof tool.result === 'string' && tool.result.trim()) {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: tool.result,
            metadata: { ...tool, is_error: false } as Record<string, unknown>,
          });
        }
      }
    }

    if (response.content || (response.thinking && response.thinking.length > 0)) {
      const thinkingContent: ThinkingContent[] | undefined = response.thinking?.map((block) => ({
        id: block.id,
        content: block.content,
        format: block.format,
        timestamp: block.timestamp || Date.now(),
      }));

      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: response.content,
        thinking: thinkingContent,
        metadata: {
          thinkingExtracted: true,
          metadata: response.metadata,
        },
      });
    }

    if (response.usage) {
      // Exec-mode: codex exec reports usage that sums input_tokens across every
      // internal agentic sub-call, so it grows quadratically with tool use and
      // routinely exceeds the context window after a single turn. We have no
      // per-call breakdown here, so flag the value as estimated and reuse the
      // last known good occupancy (from a previous tokenUsage notification, if
      // any) instead of clamping the aggregate to 100% of the context window.
      const turnTokens = response.usage.inputTokens !== undefined || response.usage.outputTokens !== undefined
        ? (response.usage.inputTokens || 0) + (response.usage.outputTokens || 0)
        : (response.usage.totalTokens || 0);

      this.cumulativeTokensUsed += turnTokens;
      const contextWindow = this.resolveContextWindow();

      const used = this.lastTurnTokens > 0 ? this.lastTurnTokens : 0;
      const contextUsage: ContextUsage = {
        used,
        total: contextWindow,
        percentage: contextWindow > 0 ? Math.min((used / contextWindow) * 100, 100) : 0,
        cumulativeTokens: this.cumulativeTokensUsed,
        isEstimated: true,
      };
      this.emit('context', contextUsage);
    }

    // Emit 'complete' AFTER all output events to guarantee correct ordering.
    // Previously this was emitted inside sendMessage() before tool/assistant
    // output events, violating consumer expectations.
    this.emit('complete', response);
  }

  // ─── Exec mode: message sending ──────────────────────────────────────

  private async prepareMessage(message: CliMessage): Promise<CliMessage> {
    const normalizedMessage = await this.normalizeMessage(message);
    return this.prepareMessageForExecution(normalizedMessage);
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const normalizedMessage = await this.normalizeMessage(message);
    const preparedMessage = this.prepareMessageForExecution(normalizedMessage);

    // Phase-specific timeout budget. First turn after spawn gets the short
    // startup budget so we surface cold-start hangs (broken auth, bad CODEX_HOME
    // symlink, API unreachable) in ~60s instead of burning the full 5 minutes.
    const phase: CodexExecPhase = this.hasCompletedExecTurn ? 'turn' : 'startup';
    const timeoutMs = phase === 'startup'
      ? CODEX_TIMEOUTS.EXEC_STARTUP_MS
      : this.resolveTurnIdleTimeoutMs();

    // Retry only on truly transient failures. A timeout means the process
    // either hung or is doing something that takes longer than our budget —
    // neither is fixed by running it again. Retrying a timeout just doubles
    // the user's wait before they see the failure.
    const maxAttempts = 2;
    let lastError: Error | null = null;
    const resumeCommandAtStart = this.shouldUseResumeCommand();

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const execution = await this.executePreparedMessage(preparedMessage, { timeoutMs, phase });
        const response = execution.response;
        const content = response.content.trim();
        const hasMeaningfulOutput = content.length > 0 || (response.toolCalls?.length || 0) > 0;
        const shouldRetry = attempt < maxAttempts
          && !hasMeaningfulOutput
          && !execution.diagnostics.some((diagnostic) => diagnostic.fatal);

        if (!shouldRetry) {
          this.recordConversationTurn(normalizedMessage, response);
          this.hasCompletedExecTurn = true;
          // Note: 'complete' is emitted by execSendMessage() AFTER all
          // output events, to guarantee correct event ordering.
          return response;
        }

        logger.info('Codex exec produced no meaningful output, retrying', {
          attempt,
          maxAttempts,
          diagnosticsCount: execution.diagnostics.length,
        });
        await this.delay(250 * attempt);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry timeouts — the process hung, re-running it won't unhang it.
        // Surface the typed error immediately so the UI can show a useful message.
        if (lastError instanceof CodexTimeoutError) {
          logger.warn('Codex exec timed out — not retrying', {
            phase: lastError.phase,
            timeoutMs: lastError.timeoutMs,
            networkErrorCount: lastError.networkErrorCount,
            lastNetworkError: lastError.lastNetworkError,
            attempt,
          });
          throw lastError;
        }

        if (resumeCommandAtStart && this.isRecoverableThreadResumeError(lastError)) {
          logger.info('Codex exec resume failed with a stale thread/session id - skipping same-command retry', {
            attempt,
            maxAttempts,
            errorMessage: lastError.message,
          });
          throw lastError;
        }

        if (attempt >= maxAttempts) {
          throw lastError;
        }

        logger.info('Codex exec threw transient error, retrying', {
          attempt,
          maxAttempts,
          errorMessage: lastError.message,
        });
        await this.delay(250 * attempt);
      }
    }

    throw lastError || new Error('Codex execution failed without a diagnostic error.');
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const response = await this.sendMessage(message);
    if (response.content) {
      yield response.content;
    }
  }

  parseOutput(raw: string): CliResponse & { thinking?: ThinkingBlock[] } {
    const parsed = parseCodexExecTranscript(raw, [], this.generateResponseId());
    return parsed.response;
  }

  protected buildArgs(message: CliMessage): string[] {
    const useResume = this.shouldUseResumeCommand();
    const args: string[] = useResume ? ['exec', 'resume'] : ['exec'];

    if (this.cliConfig.model) {
      args.push('--model', this.cliConfig.model);
    }

    args.push('--json');

    if (this.cliConfig.ephemeral && !useResume) {
      args.push('--ephemeral');
    }

    if (!useResume) {
      const sandboxMode = this.resolveExecSandboxMode();
      if (sandboxMode) {
        args.push('--sandbox', sandboxMode);
      }
    }

    if (!useResume) {
      for (const dir of this.cliConfig.additionalWritableDirs || []) {
        args.push('--add-dir', dir);
      }
    }

    if (!useResume && this.cliConfig.outputSchemaPath) {
      args.push('--output-schema', this.cliConfig.outputSchemaPath);
    }

    args.push('--skip-git-repo-check');

    // MCP servers are controlled via CODEX_HOME env var (see prepareCodexHome).
    // The `-c mcp_servers={}` CLI override does NOT actually prevent MCP loading.

    for (const attachment of message.attachments || []) {
      if (attachment.type === 'image' && attachment.path) {
        args.push('-i', attachment.path);
      }
    }

    if (useResume && this.sessionId) {
      args.push(this.sessionId);
    }

    // Prompt is written to stdin in executePreparedMessage, not as a positional arg.
    // Modern Codex CLI reads from stdin ("Reading prompt from stdin...").

    return args;
  }

  // ─── Exec mode: internal methods ─────────────────────────────────────

  private async executePreparedMessage(
    message: CliMessage,
    options: { timeoutMs: number; phase: CodexExecPhase }
  ): Promise<CodexExecutionResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      const childProcess = this.spawnProcess(args);
      const state: CodexExecutionState = {
        diagnostics: [],
        partialStderr: '',
        partialStdout: '',
        rawStderr: '',
        rawStdout: '',
        emittedDiagnosticKeys: new Set<string>(),
      };

      this.process = childProcess;

      // Idle-based watchdog. The previous absolute budget would kill codex
      // mid-work when the state-db iteration or long API calls took longer
      // than the phase budget, even though the process was actively streaming
      // progress. Reset the timer on every stdout OR stderr chunk so we only
      // terminate when the process is genuinely silent for `options.timeoutMs`.
      //
      // `lastActivityAt` and `receivedAnyData` are captured on every chunk and
      // logged on timeout so post-mortem diagnostics reveal whether the
      // process produced anything at all before stalling.
      const startedAt = Date.now();
      let lastActivityAt = startedAt;
      let receivedAnyData = false;
      let idleTimer: NodeJS.Timeout | null = null;
      const fireIdleTimeout = () => {
        if (!this.process) return;
        const elapsedMs = Date.now() - startedAt;
        const silentMs = Date.now() - lastActivityAt;
        // Count network-layer errors so the UI can distinguish "codex can't
        // reach its backend" from "codex hung doing something else entirely".
        const networkErrors = state.diagnostics.filter((d) =>
          /network error|sending request|connection (refused|reset|timed out|closed)|dns|tls|handshake/i.test(d.line)
        );
        const lastNetworkError = networkErrors.length > 0
          ? networkErrors[networkErrors.length - 1]?.line ?? null
          : null;
        logger.warn('Codex exec idle timeout — killing process tree', {
          pid: this.process.pid,
          phase: options.phase,
          idleBudgetMs: options.timeoutMs,
          silentMs,
          elapsedMs,
          receivedAnyData,
          stdoutBytes: state.rawStdout.length,
          stderrBytes: state.rawStderr.length,
          stdoutTail: state.rawStdout.slice(-500),
          stderrTail: state.rawStderr.slice(-500),
          diagnosticsTail: state.diagnostics.slice(-5).map((d) => d.line),
          networkErrorCount: networkErrors.length,
          lastNetworkError,
        });
        terminateProcessTree(this.process.pid);
        this.process = null;
        clearLivenessTimer();
        reject(new CodexTimeoutError(options.phase, options.timeoutMs, {
          networkErrorCount: networkErrors.length,
          lastNetworkError,
        }));
      };
      const resetIdleTimer = () => {
        lastActivityAt = Date.now();
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(fireIdleTimeout, options.timeoutMs);
      };
      const clearIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };
      resetIdleTimer();

      // Synthetic liveness heartbeat. Codex exec emits no progress events
      // during long reasoning blocks, MCP tool calls, or web searches — the
      // child sits silent between `item.created` and `item.completed` for
      // minutes. Without this, the outer StuckProcessDetector fires a false
      // "no output for 120s" warning (~150s after ~3 deferrals) even though
      // the process is demonstrably alive. We emit heartbeats on a fixed
      // cadence while the child is running; the idle watchdog above remains
      // the real kill-switch so hung children are still terminated.
      const livenessTimer: NodeJS.Timeout = setInterval(() => {
        if (!this.process || this.process.killed || this.process.exitCode !== null) {
          return;
        }
        this.emit('heartbeat');
      }, CODEX_TIMEOUTS.EXEC_LIVENESS_HEARTBEAT_MS);
      if (livenessTimer.unref) livenessTimer.unref();
      const clearLivenessTimer = () => {
        clearInterval(livenessTimer);
      };

      // Write the prompt to stdin — modern Codex CLI reads from stdin, not positional args
      if (childProcess.stdin) {
        if (message.content) {
          childProcess.stdin.write(message.content);
        }
        childProcess.stdin.end();
      }

      childProcess.stdout?.on('data', (data) => {
        receivedAnyData = true;
        resetIdleTimer();
        const chunk = data.toString();
        state.rawStdout += chunk;
        // Record activity from streaming output
        if (this.activityDetector && chunk) {
          this.activityDetector.recordTerminalActivity(chunk).catch((error: unknown) => {
            logger.debug('Failed to record Codex terminal activity', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
        state.partialStdout = this.consumeLines(chunk, state.partialStdout, (line) => {
          this.processStdoutLine(line, state);
        });
      });

      childProcess.stderr?.on('data', (data) => {
        receivedAnyData = true;
        resetIdleTimer();
        // Exec mode has no JSON-RPC notification stream, so stderr activity
        // is our primary liveness signal during phases that produce no stdout
        // (state-db iteration, network retries, `codex` Rust-level logging).
        // Without this, `StuckProcessDetector` fires a false "no output for
        // 120s" warning while the process is demonstrably alive. The detector's
        // `recordStderr` path is never wired up, so it's safe to treat any
        // stderr as full output-equivalent liveness here.
        this.emit('heartbeat');
        const chunk = data.toString();
        state.rawStderr += chunk;
        state.partialStderr = this.consumeLines(chunk, state.partialStderr, (line) => {
          const diagnostic = classifyCodexDiagnostic(line);
          state.diagnostics.push(diagnostic);

          // Surface non-noise diagnostics (warning + error levels, including
          // non-fatal ones like `[codex] ERROR codex_api: network error`)
          // in real-time so the user can see what codex is doing during
          // retry loops or long startup phases — not just at close. Dedupe
          // per (category, line) so repeated identical errors from a retry
          // burst appear once instead of spamming the transcript.
          if (diagnostic.level === 'info') {
            return;
          }
          const dedupKey = `${diagnostic.category}:${diagnostic.line}`;
          if (state.emittedDiagnosticKeys.has(dedupKey)) {
            diagnostic.streamed = true;
            return;
          }
          state.emittedDiagnosticKeys.add(dedupKey);
          diagnostic.streamed = true;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: diagnostic.fatal ? 'error' : 'system',
            content: `[codex] ${diagnostic.line}`,
            metadata: {
              diagnostic: true,
              category: diagnostic.category,
              fatal: diagnostic.fatal,
              level: diagnostic.level,
            },
          });
        });
      });

      childProcess.on('error', (error) => {
        clearIdleTimer();
        clearLivenessTimer();
        this.process = null;
        reject(error);
      });

      childProcess.on('close', (code, signal) => {
        clearIdleTimer();
        clearLivenessTimer();

        if (state.partialStdout.trim()) {
          this.processStdoutLine(state.partialStdout, state);
        }
        if (state.partialStderr.trim()) {
          state.diagnostics.push(classifyCodexDiagnostic(state.partialStderr));
        }

        const parsed = parseCodexExecTranscript(
          state.rawStdout,
          state.diagnostics,
          this.generateResponseId(),
        );
        const raw = [state.rawStdout.trim(), state.rawStderr.trim()].filter(Boolean).join('\n');

        if (parsed.threadId && this.supportsNativeResume()) {
          this.sessionId = parsed.threadId;
          this.shouldResumeNextTurn = true;
        }

        this.process = null;
        this.emit('exit', code, signal);

        if (code !== 0 && !parsed.hasMeaningfulOutput) {
          const diagnosticSummary = state.diagnostics.map((diagnostic) => diagnostic.line).join('\n');
          reject(new Error(diagnosticSummary || `Codex exited with code ${code}`));
          return;
        }

        resolve({
          code,
          diagnostics: state.diagnostics,
          raw,
          response: {
            ...parsed.response,
            metadata: {
              ...parsed.response.metadata,
              diagnostics: state.diagnostics,
            },
            raw,
          },
        });
      });
    });
  }

  private async normalizeMessage(message: CliMessage): Promise<CliMessage> {
    let content = message.content;
    let preparedAttachments: CliAttachment[] | undefined;

    if (message.attachments && message.attachments.length > 0) {
      const processedAttachments = await this.prepareAttachments(message.attachments);
      const imageAttachments = processedAttachments.filter(
        (attachment) => attachment.isImage && supportsCodexInlineImage(attachment.mimeType)
      );
      const fileAttachments = processedAttachments.filter(
        (attachment) => !attachment.isImage || !supportsCodexInlineImage(attachment.mimeType)
      );

      if (fileAttachments.length > 0) {
        content = buildMessageWithFiles(content, fileAttachments);
      }

      if (imageAttachments.length > 0) {
        preparedAttachments = imageAttachments.map((attachment) => ({
          type: 'image',
          path: attachment.filePath,
          mimeType: attachment.mimeType,
          name: attachment.originalName,
        }));
      }
    }

    return {
      ...message,
      content,
      attachments: preparedAttachments,
    };
  }

  /**
   * Max chars for the system prompt injected into message content.
   * Codex CLI natively loads instruction files (AGENTS.md, CLAUDE.md, etc.)
   * from the working directory, so the orchestrator's merged instruction
   * content is largely redundant.  Injecting 15 KB+ of duplicate instructions
   * causes dramatic latency increases (minutes instead of seconds) because
   * every `codex exec` call re-processes the giant prompt through the model.
   * Cap the injection so only the compact orchestrator-specific context (agent
   * role, observation, tool permissions) is sent.
   */
  private static readonly MAX_SYSTEM_PROMPT_CHARS = 4000;

  private prepareMessageForExecution(message: CliMessage): CliMessage {
    let content = message.content;

    if (!this.shouldUseResumeCommand() && this.conversationHistory.length > 0) {
      content = this.buildReplayPrompt(content);
    }

    // Skip system prompt on resume turns — the Codex thread already has full
    // context from the initial turn.  Re-injecting it wastes tokens.
    if (!this.shouldUseResumeCommand() && this.cliConfig.systemPrompt?.trim()) {
      const prompt = this.cliConfig.systemPrompt.trim();
      // Only inject the system prompt when it is reasonably short.  Large
      // prompts are almost certainly the merged project instruction files
      // which Codex already loads natively from the working directory.
      if (prompt.length <= CodexCliAdapter.MAX_SYSTEM_PROMPT_CHARS) {
        content = [
          '[SYSTEM INSTRUCTIONS]',
          prompt,
          '[/SYSTEM INSTRUCTIONS]',
          '',
          content,
        ].join('\n');
      }
    }

    return {
      ...message,
      content,
    };
  }

  private async prepareAttachments(attachments: CliAttachment[]): Promise<ProcessedAttachment[]> {
    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const fileAttachments: FileAttachment[] = attachments.map((attachment, index) => ({
      name: attachment.name || `attachment-${index}`,
      type: attachment.mimeType || (attachment.type === 'image' ? 'image/png' : 'application/octet-stream'),
      size: attachment.content?.length || 0,
      data: this.normalizeAttachmentData(attachment.content || ''),
    }));
    return processAttachments(fileAttachments, this.sessionId || generateId(), workingDirectory);
  }

  private emitDiagnostics(diagnostics?: CodexDiagnostic[]): void {
    if (!diagnostics || diagnostics.length === 0) {
      return;
    }

    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      if (diagnostic.level === 'info') {
        continue;
      }
      // Already surfaced to the UI during stderr streaming — don't double-emit.
      if (diagnostic.streamed) {
        continue;
      }
      const key = `${diagnostic.category}:${diagnostic.line}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: diagnostic.fatal ? 'error' : 'system',
        content: `[codex] ${diagnostic.line}`,
        metadata: {
          diagnostic: true,
          category: diagnostic.category,
          fatal: diagnostic.fatal,
          level: diagnostic.level,
        },
      });
    }
  }

  private processStdoutLine(line: string, state: CodexExecutionState): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = typeof event['type'] === 'string' ? event['type'] : '';

      // Every valid JSON event from `codex exec --json` is proof the turn is
      // alive. Without this, long reasoning phases (where Codex emits item
      // deltas but no command_execution tool calls) look silent to the
      // StuckProcessDetector, which fires a false "no output for 120s"
      // warning and eventually force-kills a working instance at 240s.
      // App-server mode already heartbeats on delta notifications (see
      // handleNotification); this is the exec-mode analogue.
      this.emit('heartbeat');

      // Capture thread/session ID from various Codex event names
      if (!state.threadId) {
        const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
        if (
          typeof id === 'string'
          && (eventType === 'thread.started'
            || eventType === 'session.started'
            || eventType === 'session.created'
            || eventType === 'thread.created')
        ) {
          state.threadId = id as string;
        }
      }

      // Emit real-time tool use events so the UI isn't silent during long executions
      if (eventType === 'item.created' && event['item'] && typeof event['item'] === 'object') {
        const item = event['item'] as Record<string, unknown>;
        if (item['type'] === 'command_execution' && typeof item['command'] === 'string') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running command: ${item['command'] as string}`,
            metadata: { streaming: true },
          });
        }
      }

      return;
    } catch {
      // Non-JSON lines are kept in raw stdout and parsed later as fallback content.
    }
  }

  private shouldUseResumeCommand(): boolean {
    return Boolean(this.shouldResumeNextTurn && this.sessionId);
  }

  private resolveExecSandboxMode(): CodexSandboxMode | null {
    if (this.cliConfig.approvalMode === 'full-auto') {
      return 'danger-full-access';
    }
    return this.cliConfig.sandboxMode ?? null;
  }

  /**
   * Whether the adapter can use `codex exec resume` for subsequent turns.
   * Thread resumption is a Codex thread-continuity feature and is independent
   * of the approval policy.
   */
  private supportsNativeResume(): boolean {
    return true;
  }

  private buildReplayPrompt(currentMessage: string): string {
    const replayEntries = this.conversationHistory
      .slice(-CodexCliAdapter.MAX_REPLAY_ENTRIES)
      .map((entry) => {
        const role = entry.role === 'user' ? 'User' : 'Assistant';
        return [
          `<${role}>`,
          this.truncateReplayContent(entry.content),
          `</${role}>`,
        ].join('\n');
      });

    return [
      '[CONVERSATION HISTORY]',
      'Use the recent transcript below as context for the current request.',
      '',
      ...replayEntries,
      '',
      '[/CONVERSATION HISTORY]',
      '',
      '[CURRENT USER MESSAGE]',
      currentMessage,
      '[/CURRENT USER MESSAGE]',
    ].join('\n');
  }

  private truncateReplayContent(content: string): string {
    const normalized = content.trim();
    if (normalized.length <= CodexCliAdapter.MAX_REPLAY_CHARS_PER_ENTRY) {
      return normalized;
    }
    return `${normalized.slice(0, CodexCliAdapter.MAX_REPLAY_CHARS_PER_ENTRY)}...[truncated]`;
  }

  private consumeLines(
    chunk: string,
    carry: string,
    handleLine: (line: string) => void
  ): string {
    const combined = carry + chunk;
    const lines = combined.split('\n');
    const remainder = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        handleLine(line);
      }
    }
    return remainder;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private recordConversationTurn(message: CliMessage, response: CliResponse): void {
    const userContent = this.buildHistoryEntryContent(message);
    if (userContent) {
      this.conversationHistory.push({ role: 'user', content: userContent });
    }

    const assistantContent = response.content.trim() || this.summarizeToolCalls(response.toolCalls);
    if (assistantContent) {
      this.conversationHistory.push({ role: 'assistant', content: assistantContent });
    }

    if (this.conversationHistory.length > CodexCliAdapter.MAX_REPLAY_ENTRIES) {
      this.conversationHistory = this.conversationHistory.slice(-CodexCliAdapter.MAX_REPLAY_ENTRIES);
    }
  }

  private buildHistoryEntryContent(message: CliMessage): string {
    const imageNames = (message.attachments || [])
      .filter((attachment) => attachment.type === 'image')
      .map((attachment) => attachment.name || 'image');
    const imageSummary = imageNames.length > 0
      ? `[Attached images: ${imageNames.join(', ')}]`
      : '';

    if (message.content.trim() && imageSummary) {
      return `${message.content.trim()}\n${imageSummary}`;
    }

    return message.content.trim() || imageSummary;
  }

  private summarizeToolCalls(toolCalls?: CliToolCall[]): string {
    if (!toolCalls || toolCalls.length === 0) {
      return '';
    }

    return toolCalls
      .slice(0, 3)
      .map((toolCall) => {
        if (toolCall.name === 'command_execution' && typeof toolCall.arguments['command'] === 'string') {
          return `Executed command: ${toolCall.arguments['command'] as string}`;
        }
        return `Used tool: ${toolCall.name}`;
      })
      .join('\n');
  }

  private normalizeAttachmentData(data: string): string {
    if (!data) {
      return data;
    }

    if (data.startsWith('data:')) {
      return data;
    }

    if (this.looksLikeBase64(data)) {
      return data;
    }

    return Buffer.from(data, 'utf-8').toString('base64');
  }

  private looksLikeBase64(data: string): boolean {
    if (data.length < 16 || data.length % 4 !== 0) {
      return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(data);
  }

  private prepareCodexHome(): void {
    const codexHomeDir = this.cliConfig.mcpServersConfigToml
      ? this.codexHome.prepareHomeWithMcpConfig(this.cliConfig.mcpServersConfigToml)
      : this.codexHome.prepareMcpFreeHome();
    if (codexHomeDir) {
      this.config.env = { ...this.config.env, CODEX_HOME: codexHomeDir };
    }
  }

  private cleanupCodexHome(): void {
    this.codexHome.cleanup();
  }

  /**
   * Classifies an error as "the Codex thread/session is gone" (recoverable by
   * reopening a fresh thread) vs. anything else. Requires BOTH the error text
   * to mention thread/session context AND a loss indicator — without the
   * context gate a bare "not found" from an unrelated source (e.g. a missing
   * file) would incorrectly trigger a full thread reopen.
   */
  private isRecoverableThreadResumeError(error: unknown): boolean {
    const msg = String(error instanceof Error ? error.message : error).toLowerCase();
    if (!/thread|session/.test(msg)) return false;
    return /not found|no rollout found|rollout not found|missing|no such|unknown|expired|invalid|does not exist/.test(msg);
  }

  getResumeCursor(): ResumeCursor | null {
    return this.resumeCursor;
  }

  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.lastResumeAttemptResult;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }
}
