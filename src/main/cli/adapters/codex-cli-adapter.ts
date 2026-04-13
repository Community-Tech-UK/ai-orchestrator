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
  CliMessage,
  CliResponse,
  CliStatus,
  CliToolCall,
  CliUsage,
} from './base-cli-adapter';
import type { ContextUsage, FileAttachment, InstanceStatus, OutputMessage, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent, ThinkingBlock } from '../../../shared/utils/thinking-extractor';
import { buildMessageWithFiles, processAttachments, type ProcessedAttachment } from '../file-handler';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, lstatSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getLogger } from '../../logging/logger';
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
  CodexReasoningEffort,
  ThreadItem,
  TurnCaptureState,
  TurnPhase,
} from './codex/app-server-types';
import { SERVICE_NAME } from './codex/app-server-types';
import { CodexSessionScanner } from './codex/session-scanner';
import type { ResumeCursor } from '../../session/session-continuity';

const logger = getLogger('CodexCliAdapter');

// ─── Local Types ────────────────────────────────────────────────────────────

type CodexApprovalMode = 'suggest' | 'auto-edit' | 'full-auto';
type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

interface CodexDiagnostic {
  category: 'auth' | 'mcp' | 'models' | 'process' | 'sandbox' | 'session' | 'startup' | 'unknown';
  fatal: boolean;
  line: string;
  level: 'error' | 'info' | 'warning';
}

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
  toolCalls: CliToolCall[];
  threadId?: string;
  usage?: CliUsage;
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
  /** Model to use (gpt-5.4, gpt-5.3-codex, etc.) */
  model?: string;
  /** JSON Schema object for structured output (app-server mode) */
  outputSchema?: Record<string, unknown>;
  /** Path to a JSON schema file describing the final output (exec mode) */
  outputSchemaPath?: string;
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

/** Codex inline image inputs only support a subset of image mime types. */
const CODEX_INLINE_IMAGE_MIME_TYPES = new Set([
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
]);

function supportsCodexInlineImage(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  return CODEX_INLINE_IMAGE_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

// ─── Reasoning Deduplication (ported from codex-plugin-cc) ─────────────────

/** Normalize whitespace for dedup comparison. */
function normalizeReasoningText(text: unknown): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Recursively extracts reasoning text from the heterogeneous `summary` field
 * that Codex sends on `reasoning` item completions. The value can be a plain
 * string, an array of strings/objects, or a nested object with `text`,
 * `summary`, `content`, or `parts` keys.
 */
function extractReasoningSections(value: unknown): string[] {
  if (!value) return [];

  if (typeof value === 'string') {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj['text'] === 'string') return extractReasoningSections(obj['text']);
    if ('summary' in obj) return extractReasoningSections(obj['summary']);
    if ('content' in obj) return extractReasoningSections(obj['content']);
    if ('parts' in obj) return extractReasoningSections(obj['parts']);
  }

  return [];
}

/** Merge new reasoning sections into existing, skipping duplicates. */
function mergeReasoningSections(existing: string[], next: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existing, ...next]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) continue;
    merged.push(normalized);
  }
  return merged;
}

/** Shorten a string to maxLen chars, appending ellipsis if truncated. */
function shorten(text: string | undefined, maxLen: number): string {
  if (!text) return '';
  return text.length <= maxLen ? text : text.slice(0, maxLen - 1) + '…';
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
  /** Temp directory used as CODEX_HOME to bypass user MCP servers (exec mode) */
  private codexHomeDir?: string;
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
  /** Whether a turn is currently in progress. */
  private turnInProgress = false;
  /** Whether the system prompt has been sent (app-server mode, first turn only). */
  private systemPromptSent = false;

  // ─── Exec mode state ──────────────────────────────────────────────
  private conversationHistory: CodexConversationEntry[] = [];
  private shouldResumeNextTurn: boolean;

  // ─── Resume cursor state ──────────────────────────────────────────
  private sessionScanner = new CodexSessionScanner();
  private resumeCursor: ResumeCursor | null = null;
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

    if (appServerAvailable) {
      // App-server mode: persistent JSON-RPC connection
      try {
        await Promise.race([
          this.initAppServerMode(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Codex app-server initialization timed out after 30s')), 30_000)
          ),
        ]);
        this.useAppServer = true;
        logger.info('Codex adapter using app-server mode');
      } catch (err) {
        logger.warn('App-server initialization failed, falling back to exec mode', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.useAppServer = false;
        this.prepareCleanCodexHome();
      }
    } else {
      // Exec mode: spawn per message
      this.prepareCleanCodexHome();
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
  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
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
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Codex error: ${error instanceof Error ? error.message : String(error)}`,
      });
      this.emit('status', 'error' as InstanceStatus);
      throw error;
    }
  }

  /**
   * Gracefully interrupts the current turn.
   * - App-server mode: sends `turn/interrupt` RPC (preserves thread state)
   * - Exec mode: SIGINT to the process
   */
  override interrupt(): boolean {
    if (this.useAppServer && this.appServerClient && this.turnInProgress) {
      // Graceful RPC interrupt — preserves the thread for future turns
      if (this.appServerThreadId && this.currentTurnId) {
        this.appServerClient.request('turn/interrupt', {
          threadId: this.appServerThreadId,
          turnId: this.currentTurnId,
        }).catch((err) => {
          logger.warn('Failed to interrupt turn via RPC', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return true;
      }
    }
    // Fall back to base class SIGINT behavior
    return super.interrupt();
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

      // Step 1: Resume from persisted cursor (if config.resume and cursor is fresh)
      if (this.shouldResumeNextTurn && this.sessionId) {
        try {
          const resumeResult = await client.request('thread/resume', {
            threadId: this.sessionId,
            cwd,
            model: this.cliConfig.model || null,
            approvalPolicy,
            sandbox,
          });
          threadId = resumeResult.threadId || resumeResult.thread?.id || null;
          resumeSource = 'native';
          logger.info('App-server thread resumed from persisted cursor', { threadId });
        } catch (error) {
          if (this.isRecoverableThreadResumeError(error)) {
            logger.warn('Persisted cursor resume failed (recoverable), trying JSONL scan', { error: String(error) });
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
            const resumeResult = await client.request('thread/resume', {
              threadId: scanResult.threadId,
              cwd,
              model: this.cliConfig.model || null,
              approvalPolicy,
              sandbox,
            });
            threadId = resumeResult.threadId || resumeResult.thread?.id || null;
            resumeSource = 'jsonl-scan';
            logger.info('App-server thread resumed from JSONL scan', { threadId, scannedFile: scanResult.sessionFilePath });
          } catch (error) {
            if (this.isRecoverableThreadResumeError(error)) {
              logger.warn('JSONL scan resume failed (recoverable), falling back to fresh start', { error: String(error) });
            } else {
              throw error;
            }
          }
        } else {
          logger.info('No matching Codex session found on filesystem for workspace', { cwd });
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
    return connectToAppServer(cwd);
  }

  /**
   * Sends a message via the app-server and emits real-time events.
   */
  private async appServerSendMessage(message: string, attachments?: FileAttachment[]): Promise<void> {
    if (!this.appServerClient || !this.appServerThreadId) {
      throw new Error('App-server not initialized');
    }

    // Reset per-turn flag so the fallback path works if this turn doesn't
    // receive a thread/tokenUsage/updated notification.
    this.hasTokenUsageNotification = false;

    // Process attachments — prepend file references to the user message (not replace it)
    let content = message;
    if (attachments && attachments.length > 0) {
      const processed = await this.prepareAttachmentsForAppServer(attachments);
      if (processed) {
        content = `${processed}\n\n${message}`;
      }
    }

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
    const turnState = await this.captureTurn(content);

    // Check for failed turns (e.g., context overflow, API errors).
    // Codex reports these as turn/completed with status: "failed".
    const turnStatus = turnState.finalTurn?.status;
    if (turnStatus === 'failed' || turnState.error) {
      const errorMsg = turnState.error instanceof Error
        ? turnState.error.message
        : (typeof turnState.error === 'string' ? turnState.error : 'Codex turn failed');
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
  private async captureTurn(content: string): Promise<TurnCaptureState> {
    const client = this.appServerClient!;
    const threadId = this.appServerThreadId!;

    // Build turn capture state
    const state = this.createTurnCaptureState(threadId);

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
      const timeoutMs = activeItems > 0
        ? CODEX_TIMEOUTS.NOTIFICATION_IDLE_ACTIVE_MS
        : CODEX_TIMEOUTS.NOTIFICATION_IDLE_MS;
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

    let turnTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      // Start the turn
      this.turnInProgress = true;
      const turnParams: Record<string, unknown> = {
        threadId,
        input: [{ type: 'text', text: content, text_elements: [] }],
      };

      // Add structured output schema if configured
      if (this.cliConfig.outputSchema) {
        turnParams['outputSchema'] = this.cliConfig.outputSchema;
      }

      // Add reasoning effort if configured
      if (this.cliConfig.reasoningEffort) {
        turnParams['reasoningEffort'] = this.cliConfig.reasoningEffort;
      }

      const turnResult = await client.request('turn/start', turnParams as unknown as AppServerRequestParams<'turn/start'>);
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

      // Start the idle watchdog now that the turn is in progress.
      // Uses the short timeout because no item has started yet.
      armIdleWatchdog();

      // Wait for completion with timeout protection.
      // If the codex process crashes or the socket drops, the exitPromise
      // will resolve and we reject to avoid hanging forever.
      const timeoutMs = this.config.timeout;
      const completionOrCrash = Promise.race([
        state.completion,
        client.exitPromise.then(() => {
          if (!state.completed) {
            throw new Error('codex app-server exited unexpectedly during turn');
          }
          return state;
        }),
        new Promise<never>((_, reject) => {
          turnTimeoutTimer = setTimeout(
            () => reject(new Error(`Codex app-server turn timed out after ${timeoutMs}ms`)),
            timeoutMs
          );
          turnTimeoutTimer.unref();
        }),
      ]);

      return await completionOrCrash;
    } finally {
      this.turnInProgress = false;
      this.currentTurnId = null;
      // Clear all timers to prevent leaks
      if (turnTimeoutTimer) clearTimeout(turnTimeoutTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (state.completionTimer) {
        clearTimeout(state.completionTimer);
      }
      client.setNotificationHandler(previousHandler);
    }
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
        }).catch(() => {});
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
        const errorMessage = params['message'] as string || 'Unknown error from codex app-server';
        const codexErrorInfo = params['codex_error_info'] as string | undefined;
        // Include codex_error_info in the error message so upstream overflow detection
        // can match it (e.g., "ContextWindowExceeded" matches /context.?window.?exceeded/i).
        const fullMessage = codexErrorInfo
          ? `${errorMessage} [codex_error_info: ${codexErrorInfo}]`
          : errorMessage;
        state.error = new Error(fullMessage);
        logger.warn('Error notification from app-server', { error: errorMessage, codexErrorInfo });
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
    if (this.cliConfig.approvalMode === 'full-auto') return 'workspace-write';
    return this.cliConfig.sandboxMode || 'read-only';
  }

  private async prepareAttachmentsForAppServer(attachments: FileAttachment[]): Promise<string | null> {
    if (attachments.length === 0) return null;

    // App-server protocol only supports text input — warn about dropped images
    const inlineImageAttachments = attachments.filter(
      (attachment) => attachment.type.startsWith('image/') && supportsCodexInlineImage(attachment.type)
    );
    if (inlineImageAttachments.length > 0) {
      const names = inlineImageAttachments.map((attachment) => attachment.name).join(', ');
      logger.warn('Image attachments not supported in app-server mode, dropped', {
        count: inlineImageAttachments.length,
        names,
      });
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'system',
        content: `⚠ ${inlineImageAttachments.length} image attachment(s) dropped — Codex app-server mode does not support images (${names})`,
      });
    }

    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const fileAttachments = attachments.filter(
      (attachment) => !attachment.type.startsWith('image/') || !supportsCodexInlineImage(attachment.type)
    );
    if (fileAttachments.length === 0) return null;
    const processed = await processAttachments(fileAttachments, this.sessionId || generateId(), workingDirectory);
    if (processed.length === 0) return null;
    return buildMessageWithFiles('', processed);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Exec Mode Implementation (Fallback)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Sends a message via `codex exec` (spawn-per-message fallback mode).
   */
  private async execSendMessage(message: string, attachments?: FileAttachment[]): Promise<void> {
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
    const maxAttempts = 2;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const execution = await this.executePreparedMessage(preparedMessage);
        const response = execution.response;
        const content = response.content.trim();
        const hasMeaningfulOutput = content.length > 0 || (response.toolCalls?.length || 0) > 0;
        const shouldRetry = attempt < maxAttempts
          && !hasMeaningfulOutput
          && !execution.diagnostics.some((diagnostic) => diagnostic.fatal);

        if (!shouldRetry) {
          this.recordConversationTurn(normalizedMessage, response);
          // Note: 'complete' is emitted by execSendMessage() AFTER all
          // output events, to guarantee correct event ordering.
          return response;
        }

        await this.delay(250 * attempt);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt >= maxAttempts) {
          throw lastError;
        }
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
    const parsed = this.parseTranscript(raw, []);
    return parsed.response;
  }

  protected buildArgs(message: CliMessage): string[] {
    const useResume = this.shouldUseResumeCommand();
    const args: string[] = useResume ? ['exec', 'resume'] : ['exec'];

    if (this.cliConfig.model) {
      args.push('--model', this.cliConfig.model);
    }

    args.push('--json');

    if (this.cliConfig.ephemeral) {
      args.push('--ephemeral');
    }

    if (!useResume) {
      if (this.cliConfig.approvalMode === 'full-auto') {
        args.push('--full-auto');
      } else if (this.cliConfig.sandboxMode) {
        args.push('--sandbox', this.cliConfig.sandboxMode);
      }
    } else if (this.cliConfig.approvalMode === 'full-auto') {
      args.push('--full-auto');
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

    // MCP servers are disabled via CODEX_HOME env var (see prepareCleanCodexHome).
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

  private classifyDiagnostic(line: string): CodexDiagnostic {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    const hasErrorLevel = /\berror\b/i.test(trimmed);
    const hasWarnLevel = /\bwarn\b/i.test(trimmed);

    if (
      lower.includes('failed to refresh available models')
      || lower.includes('timeout waiting for child process to exit')
    ) {
      return { category: 'models', fatal: false, line: trimmed, level: 'warning' };
    }

    if (
      lower.includes('failed to terminate mcp process group')
      || lower.includes('failed to kill mcp process group')
    ) {
      return { category: 'mcp', fatal: false, line: trimmed, level: 'warning' };
    }

    if (lower.includes('failed to delete shell snapshot')) {
      return { category: 'startup', fatal: false, line: trimmed, level: 'warning' };
    }

    // Internal Codex state-db housekeeping logs (e.g. "state db missing rollout path for thread ...")
    // These are non-actionable Rust-level diagnostics that should not surface to the user.
    if (lower.includes('state db missing rollout path') || lower.includes('codex_core::rollout')) {
      return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
    }

    if (
      lower.includes('unauthorized')
      || lower.includes('authentication')
      || lower.includes('forbidden')
      || lower.includes('login required')
    ) {
      return { category: 'auth', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('unknown model')
      || lower.includes('model not found')
      || lower.includes('invalid model')
    ) {
      return { category: 'models', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('session not found')
      || lower.includes('thread not found')
      || lower.includes('no matching session')
    ) {
      return { category: 'session', fatal: true, line: trimmed, level: 'error' };
    }

    if (
      lower.includes('permission denied')
      || lower.includes('sandbox')
      || lower.includes('dangerously-bypass-approvals-and-sandbox')
    ) {
      return { category: 'sandbox', fatal: hasErrorLevel, line: trimmed, level: hasErrorLevel ? 'error' : 'warning' };
    }

    if (hasWarnLevel) {
      return { category: 'unknown', fatal: false, line: trimmed, level: 'warning' };
    }

    if (hasErrorLevel) {
      return { category: 'process', fatal: false, line: trimmed, level: 'warning' };
    }

    return { category: 'unknown', fatal: false, line: trimmed, level: 'info' };
  }

  private cleanContent(raw: string): string {
    const nonJsonContent = raw
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() && !line.trim().startsWith('{'))
      .join('\n');
    const { response } = extractThinkingContent(nonJsonContent);
    return response
      .replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/g, '')
      .replace(/\[codex\].*$/gim, '')
      .trim();
  }

  private async executePreparedMessage(message: CliMessage): Promise<CodexExecutionResult> {
    return new Promise((resolve, reject) => {
      const args = this.buildArgs(message);
      const childProcess = this.spawnProcess(args);
      const state: CodexExecutionState = {
        diagnostics: [],
        partialStderr: '',
        partialStdout: '',
        rawStderr: '',
        rawStdout: '',
        toolCalls: [],
      };

      this.process = childProcess;

      // Write the prompt to stdin — modern Codex CLI reads from stdin, not positional args
      if (childProcess.stdin) {
        if (message.content) {
          childProcess.stdin.write(message.content);
        }
        childProcess.stdin.end();
      }

      childProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        state.rawStdout += chunk;
        // Record activity from streaming output
        if (this.activityDetector && chunk) {
          this.activityDetector.recordTerminalActivity(chunk).catch(() => {});
        }
        state.partialStdout = this.consumeLines(chunk, state.partialStdout, (line) => {
          this.processStdoutLine(line, state);
        });
      });

      childProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        state.rawStderr += chunk;
        state.partialStderr = this.consumeLines(chunk, state.partialStderr, (line) => {
          const diagnostic = this.classifyDiagnostic(line);
          state.diagnostics.push(diagnostic);

          // Emit fatal diagnostics immediately so the user doesn't wait
          // minutes only to discover an auth/config error at the end.
          if (diagnostic.fatal) {
            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'error',
              content: `[codex] ${diagnostic.line}`,
              metadata: { diagnostic: true, category: diagnostic.category, fatal: true },
            });
          }
        });
      });

      const timeout = setTimeout(() => {
        if (this.process) {
          // Use cross-platform process tree termination
          terminateProcessTree(this.process.pid);
          this.process = null;
          reject(new Error('Codex CLI timeout'));
        }
      }, this.config.timeout);

      childProcess.on('error', (error) => {
        clearTimeout(timeout);
        this.process = null;
        reject(error);
      });

      childProcess.on('close', (code, signal) => {
        clearTimeout(timeout);

        if (state.partialStdout.trim()) {
          this.processStdoutLine(state.partialStdout, state);
        }
        if (state.partialStderr.trim()) {
          state.diagnostics.push(this.classifyDiagnostic(state.partialStderr));
        }

        const parsed = this.parseTranscript(state.rawStdout, state.diagnostics);
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

  private extractTextFromItem(item: Record<string, unknown>): string | undefined {
    if (typeof item['text'] === 'string') {
      return item['text'];
    }

    const message = item['message'];
    if (message && typeof message === 'object' && typeof (message as Record<string, unknown>)['content'] === 'string') {
      return (message as Record<string, unknown>)['content'] as string;
    }

    const content = item['content'];
    if (typeof content === 'string') {
      return content;
    }

    return undefined;
  }

  private parseTranscript(
    rawStdout: string,
    diagnostics: CodexDiagnostic[]
  ): {
    hasMeaningfulOutput: boolean;
    response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
    threadId?: string;
  } {
    const lines = rawStdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: CliToolCall[] = [];
    let usage: CliUsage | undefined;
    let threadId: string | undefined;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = typeof event['type'] === 'string' ? event['type'] : '';

        // Capture thread/session ID from various Codex event formats.
        // Different Codex CLI versions use different event names.
        if (!threadId) {
          const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
          if (
            typeof id === 'string'
            && (type === 'thread.started'
              || type === 'session.started'
              || type === 'session.created'
              || type === 'thread.created')
          ) {
            threadId = id;
            continue;
          }
        }

        if (type === 'turn.completed' && event['usage'] && typeof event['usage'] === 'object') {
          const usageEvent = event['usage'] as Record<string, unknown>;
          const inputTokens = typeof usageEvent['input_tokens'] === 'number' ? usageEvent['input_tokens'] : 0;
          const outputTokens = typeof usageEvent['output_tokens'] === 'number' ? usageEvent['output_tokens'] : 0;
          usage = {
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          };
          continue;
        }

        if (type === 'item.completed' && event['item'] && typeof event['item'] === 'object') {
          const item = event['item'] as Record<string, unknown>;
          const itemType = typeof item['type'] === 'string' ? item['type'] : '';

          if (itemType === 'agent_message') {
            const text = this.extractTextFromItem(item);
            if (text) {
              contentParts.push(text);
            }
            continue;
          }

          if (itemType === 'command_execution') {
            toolCalls.push({
              id: typeof item['id'] === 'string' ? item['id'] : `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: 'command_execution',
              arguments: {
                command: item['command'],
                exitCode: item['exit_code'],
                status: item['status'],
              },
              result: typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : undefined,
            });
            continue;
          }

          // Reasoning items are the model's chain-of-thought — capture
          // separately so they don't leak into the visible response content.
          if (itemType === 'reasoning') {
            const sections = extractReasoningSections(item['summary'] ?? item['summaryText'] ?? item['text'] ?? item['content']);
            reasoningParts.push(...sections);
            continue;
          }

          // Skip other non-content item types that shouldn't appear in the
          // response (file changes, tool calls, web searches, etc.).
          if (itemType === 'file_change' || itemType === 'fileChange'
            || itemType === 'mcpToolCall' || itemType === 'dynamicToolCall'
            || itemType === 'webSearch' || itemType === 'exitedReviewMode'
            || itemType === 'collaboration') {
            continue;
          }

          // Only fall through for genuinely unrecognized content-bearing items
          const fallbackText = this.extractTextFromItem(item);
          if (fallbackText) {
            contentParts.push(fallbackText);
          }
          continue;
        }

        if (type === 'message' && typeof event['content'] === 'string') {
          contentParts.push(event['content']);
          continue;
        }

        if (type === 'agent_message' && event['message'] && typeof event['message'] === 'object') {
          const message = event['message'] as Record<string, unknown>;
          if (typeof message['content'] === 'string') {
            contentParts.push(message['content']);
          }
          continue;
        }

        if (type === 'text' && typeof event['text'] === 'string') {
          contentParts.push(event['text']);
          continue;
        }
      } catch {
        if (!line.startsWith('{')) {
          contentParts.push(line);
        }
      }
    }

    let content = contentParts.join('\n').trim();
    if (!content) {
      content = this.cleanContent(rawStdout);
    }

    if (toolCalls.length === 0) {
      toolCalls.push(...this.extractToolCallsFromFallback(rawStdout));
    }

    const extracted = extractThinkingContent(content);

    // Merge thinking from structured reasoning items + heuristic extraction
    const allThinking: ThinkingBlock[] = [];

    // Structured reasoning items (from item.completed type:reasoning events)
    const dedupedReasoning = mergeReasoningSections([], reasoningParts);
    if (dedupedReasoning.length > 0) {
      allThinking.push({
        id: generateId(),
        content: dedupedReasoning.join('\n\n'),
        format: 'structured',
      });
    }

    // Heuristic-extracted thinking from agent message text
    allThinking.push(...extracted.thinking);

    return {
      hasMeaningfulOutput: extracted.response.trim().length > 0 || toolCalls.length > 0,
      response: {
        id: this.generateResponseId(),
        content: extracted.response,
        role: 'assistant',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        metadata: {
          diagnostics,
          threadId,
        },
        raw: rawStdout,
        thinking: allThinking.length > 0 ? allThinking : undefined,
      },
      threadId,
    };
  }

  private processStdoutLine(line: string, state: CodexExecutionState): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      const eventType = typeof event['type'] === 'string' ? event['type'] : '';

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

  private extractToolCallsFromFallback(raw: string): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];
    const toolPattern = /\[TOOL:\s*(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
    let match: RegExpExecArray | null;

    while ((match = toolPattern.exec(raw)) !== null) {
      toolCalls.push({
        id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: match[1],
        arguments: { raw: match[2].trim() },
      });
    }

    return toolCalls;
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

  // ============ MCP-free CODEX_HOME (exec mode only) ============

  /**
   * Create a clean CODEX_HOME directory that mirrors ~/.codex/ but without
   * MCP server definitions.  The `-c mcp_servers={}` CLI override is broken
   * in the Codex CLI — it does NOT prevent MCP tool descriptions from being
   * loaded into the system prompt (~87K tokens, 60-90s startup per server).
   *
   * Instead we create a temp directory, symlink everything from the real
   * ~/.codex/ (auth, sessions, models cache, etc.), and write a stripped
   * config.toml that omits all [mcp_servers.*] sections.
   */
  private prepareCleanCodexHome(): void {
    const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
    const codexDir = join(homeDir, '.codex');

    if (!existsSync(codexDir)) {
      logger.debug('No ~/.codex directory found, skipping CODEX_HOME override');
      return;
    }

    const configPath = join(codexDir, 'config.toml');
    if (!existsSync(configPath)) {
      logger.debug('No ~/.codex/config.toml found, skipping CODEX_HOME override');
      return;
    }

    // Check if the config even has MCP servers before creating the override
    const configContent = readFileSync(configPath, 'utf-8');
    if (!configContent.includes('[mcp_servers')) {
      logger.debug('No MCP servers in config, skipping CODEX_HOME override');
      return;
    }

    try {
      const tempDir = mkdtempSync(join(tmpdir(), 'codex-nomcp-'));

      // Symlink all files/dirs from ~/.codex/ except config.toml
      const entries = readdirSync(codexDir);
      for (const entry of entries) {
        if (entry === 'config.toml') continue;
        const source = join(codexDir, entry);
        const target = join(tempDir, entry);
        try {
          // Use the same type of symlink as the source (file vs dir)
          const stat = lstatSync(source);
          symlinkSync(source, target, stat.isDirectory() ? 'dir' : 'file');
        } catch {
          // Skip entries that can't be symlinked (e.g., permission issues)
          logger.debug('Could not symlink codex entry', { entry });
        }
      }

      // Write config.toml with MCP servers stripped
      const strippedConfig = this.stripMcpServers(configContent);
      writeFileSync(join(tempDir, 'config.toml'), strippedConfig, 'utf-8');

      this.codexHomeDir = tempDir;
      this.config.env = { ...this.config.env, CODEX_HOME: tempDir };

      logger.info('Created MCP-free CODEX_HOME', { path: tempDir });
    } catch (err) {
      logger.warn('Failed to create clean CODEX_HOME, MCP servers may cause latency', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Strip all [mcp_servers.*] sections from a TOML config string.
   * Uses line-by-line processing: when a [mcp_servers...] header is found,
   * all subsequent lines are skipped until a non-mcp_servers header appears.
   */
  private stripMcpServers(config: string): string {
    const lines = config.split('\n');
    const result: string[] = [];
    let inMcpSection = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Detect TOML table headers: [section] or [section.subsection]
      if (/^\[.+\]$/.test(trimmed)) {
        if (trimmed.startsWith('[mcp_servers')) {
          inMcpSection = true;
          continue;
        }
        inMcpSection = false;
      }

      if (!inMcpSection) {
        result.push(line);
      }
    }

    return result.join('\n');
  }

  private cleanupCodexHome(): void {
    if (this.codexHomeDir) {
      try {
        rmSync(this.codexHomeDir, { recursive: true, force: true });
        logger.debug('Cleaned up CODEX_HOME', { path: this.codexHomeDir });
      } catch {
        // Best-effort cleanup; OS will reclaim temp dir eventually
      }
      this.codexHomeDir = undefined;
    }
  }

  private isRecoverableThreadResumeError(error: unknown): boolean {
    const msg = String(error).toLowerCase();
    return ['not found', 'missing thread', 'unknown thread', 'unknown session',
            'expired', 'invalid thread'].some(pattern => msg.includes(pattern));
  }

  getResumeCursor(): ResumeCursor | null {
    return this.resumeCursor;
  }
}
