/**
 * ACP CLI Adapter
 *
 * Implements the Agent Client Protocol over stdio and translates ACP session
 * updates into the existing adapter event surface used by the orchestrator.
 *
 * This is intentionally transport-focused: it does not assume a specific ACP
 * agent binary or expose ACP as a first-class UI-selectable provider yet.
 */

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import {
  BaseCliAdapter,
  type AdapterRuntimeCapabilities,
  type CliAdapterConfig,
  type CliAttachment as AdapterCliAttachment,
  type CliCapabilities,
  type CliMessage,
  type CliResponse,
  type CliStatus,
  type CliToolCall,
  ndjsonSafeStringify,
} from './base-cli-adapter';
import { getLogger } from '../../logging/logger';
import { generateId } from '../../../shared/utils/id-generator';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import type {
  AcpAgentCapabilities,
  AcpAvailableCommandsUpdate,
  AcpClientCapabilities,
  AcpContentBlock,
  AcpElicitationCompleteParams,
  AcpElicitationCreateParams,
  AcpImplementationInfo,
  AcpInitializeParams,
  AcpInitializeResult,
  AcpJsonRpcErrorResponse,
  AcpJsonRpcId,
  AcpJsonRpcMessage,
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcSuccessResponse,
  AcpMcpServerConfig,
  AcpPermissionOption,
  AcpPlanUpdate,
  AcpPromptUsage,
  AcpSessionLoadParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionRequestPermissionOutcome,
  AcpSessionRequestPermissionParams,
  AcpSessionUpdate,
  AcpSessionUpdateNotificationParams,
  AcpToolCallDeltaUpdate,
  AcpToolCallOutputItem,
  AcpToolCallStatus,
  AcpToolKind,
} from '../../../shared/types/cli.types';
import {
  isAcpJsonRpcErrorResponse,
  isAcpJsonRpcNotification,
  isAcpJsonRpcRequest,
  isAcpJsonRpcSuccessResponse,
} from '../../../shared/types/cli.types';
import type { PermissionRegistry } from '../../orchestration/permission-registry';
import type { PermissionDecision, PermissionRequest } from '../../../shared/types/permission-registry.types';
import { buildCliSpawnOptions } from '../cli-environment';
import type { ProviderConcurrencyLimiter } from '../provider-concurrency-limiter';

const logger = getLogger('AcpCliAdapter');

const ACP_PROTOCOL_VERSION = 1;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_REQUEST = -32600;

/**
 * Default per-request timeout for ACP JSON-RPC calls. Without a timeout the
 * `pendingRequests` Map entries accumulate forever when the agent stops
 * responding (observed in the wild: Copilot ACP sessions hanging mid-turn
 * after an orphaned `session/request_permission` round-trip).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Prompt turns can legitimately take many minutes (long agentic loops with
 * sub-tool calls), so they get a generous ceiling separate from the default.
 * Still bounded so a truly hung agent produces a visible timeout error
 * instead of silently eating input forever.
 */
const DEFAULT_PROMPT_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a prompt turn can go without ANY `session/update` notification
 * before we surface a stall warning (UI can offer "cancel this turn?").
 * Distinct from the hard `promptTimeoutMs`: this is a gentler heuristic
 * that fires earlier so the user gets an escalation affordance instead
 * of watching a frozen "Making edits" spinner for 10 minutes.
 *
 * Only fires while a prompt is actually in flight — idle sessions don't
 * emit spurious stall warnings.
 */
const DEFAULT_STALL_WARNING_MS = 3 * 60_000;

const DEFAULT_CLIENT_INFO: AcpImplementationInfo = {
  name: 'ai-orchestrator',
  title: 'AI Orchestrator',
  version: 'dev',
};

const DEFAULT_CLIENT_CAPABILITIES: AcpClientCapabilities = {};

const ACP_CAPABILITIES: CliCapabilities = {
  streaming: true,
  toolUse: true,
  fileAccess: true,
  shellExecution: true,
  multiTurn: true,
  vision: true,
  codeExecution: true,
  contextWindow: 200_000,
  outputFormats: ['jsonrpc', 'text'],
};

interface AcpPendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Timer that rejects the pending promise if the agent never replies.
   *  Cleared on any settle path (resolve, reject, cancel, terminate). */
  timer: ReturnType<typeof setTimeout>;
}

interface AcpObservedToolCall {
  id: string;
  title: string;
  kind: AcpToolKind;
  status: AcpToolCallStatus;
  rawInput?: Record<string, unknown>;
}

interface AcpPendingPromptTurn {
  responseId: string;
  startedAt: number;
  chunks: string[];
  messageChunksById: Map<string, string[]>;
}

interface AcpPendingPermissionRequest {
  key: string;
  rpcId: AcpJsonRpcId;
  sessionId: string;
  toolCallId?: string;
  title: string;
  kind: AcpToolKind;
  options: AcpPermissionOption[];
}

export interface AcpCliAdapterConfig extends Omit<CliAdapterConfig, 'command' | 'cwd'> {
  adapterName?: string;
  command?: string;
  model?: string;
  systemPrompt?: string;
  workingDirectory: string;
  sessionId?: string;
  resume?: boolean;
  mcpServers?: AcpMcpServerConfig[];
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
  permissionRequestTimeoutMs?: number;
  permissionRegistry?: Pick<PermissionRegistry, 'requestPermission'>;
  permissionContext?: {
    instanceId: string;
    childId?: string;
  };
  /** Per-method JSON-RPC timeout override for non-prompt requests.
   *  Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Timeout for `session/prompt` RPCs. Prompt turns are long-running so
   *  this is intentionally looser than `requestTimeoutMs`. Defaults to
   *  {@link DEFAULT_PROMPT_TIMEOUT_MS}. */
  promptTimeoutMs?: number;
  /** Provider concurrency gate. When set, `spawn()` will block until a
   *  slot keyed on `concurrencyKey` is available. Prevents unbounded
   *  ACP fan-out (observed: 5+ Copilot children spawned simultaneously,
   *  amplifying the orphaned-tool-call hang). */
  concurrencyLimiter?: Pick<ProviderConcurrencyLimiter, 'acquire'>;
  /** Limiter key — typically the provider name (`'copilot'`, `'cursor'`). */
  concurrencyKey?: string;
  /** Emit a `stall_warning` event + error OutputMessage if a prompt turn
   *  goes this long without any `session/update` notification. Gives the
   *  UI an earlier signal than the hard `promptTimeoutMs` so users see
   *  "looks stuck — cancel?" before their session has been frozen for
   *  10 minutes. Defaults to {@link DEFAULT_STALL_WARNING_MS}.
   *  Set to 0 to disable. */
  stallWarningMs?: number;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : fallback);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripDataUrlPrefix(data: string): string {
  if (!data.startsWith('data:')) {
    return data;
  }

  const commaIndex = data.indexOf(',');
  return commaIndex === -1 ? data : data.slice(commaIndex + 1);
}

function parseDataUrl(data: string): { mimeType?: string; base64Data: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.+)$/i.exec(data);
  if (!match) {
    return null;
  }

  return {
    mimeType: match[1] || undefined,
    base64Data: match[2] || '',
  };
}

function isTextLikeMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) {
    return false;
  }

  const normalized = mimeType.trim().toLowerCase();
  return (
    normalized.startsWith('text/')
    || normalized === 'application/json'
    || normalized === 'application/xml'
    || normalized.endsWith('+json')
    || normalized.endsWith('+xml')
  );
}

function buildAttachmentUri(name?: string): string {
  const normalizedName = encodeURIComponent(name?.trim() || 'attachment');
  return `attachment://${normalizedName}`;
}

export class AcpCliAdapter extends BaseCliAdapter {
  private static readonly MAX_SYSTEM_PROMPT_CHARS = 4000;

  private readonly acpConfig: AcpCliAdapterConfig;
  private readonly pendingRequests = new Map<string, AcpPendingRequest>();
  private readonly toolCalls = new Map<string, AcpObservedToolCall>();
  private readonly pendingPermissionRequests = new Map<string, AcpPendingPermissionRequest>();
  private stdoutBuffer = '';
  private requestCounter = 0;
  private initialized = false;
  private agentCapabilities: AcpAgentCapabilities | null = null;
  private currentPrompt: AcpPendingPromptTurn | null = null;
  private currentPromptRequestId: string | null = null;
  private systemPromptSent = false;
  /** Release function returned by `ProviderConcurrencyLimiter.acquire`.
   *  Set in `spawn()` when concurrency gating is configured, invoked
   *  exactly once on the first of {terminate, exit, spawn-failure}. */
  private concurrencyRelease: (() => void) | null = null;
  /** Stall watchdog timer — fires if a prompt turn receives no
   *  `session/update` for longer than `stallWarningMs`. Rearmed on
   *  every inbound update; cleared when the turn settles. */
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether a stall has already been reported for the current turn
   *  (prevents re-emitting on every missed update after the threshold). */
  private stallWarningEmitted = false;

  constructor(config: AcpCliAdapterConfig) {
    super({
      command: config.command ?? 'acp-agent',
      args: config.args,
      cwd: config.workingDirectory,
      timeout: config.timeout,
      env: config.env,
      maxRetries: config.maxRetries,
      sessionPersistence: true,
      persistLargeOutputs: config.persistLargeOutputs,
    });
    this.acpConfig = {
      permissionRequestTimeoutMs: 60_000,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      stallWarningMs: DEFAULT_STALL_WARNING_MS,
      ...config,
    };
  }

  getName(): string {
    return this.acpConfig.adapterName?.trim() || 'ACP';
  }

  getCapabilities(): CliCapabilities {
    return ACP_CAPABILITIES;
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: true,
      supportsDeferPermission: false,
    };
  }

  async checkStatus(): Promise<CliStatus> {
    const command = this.acpConfig.command ?? this.getConfig().command;
    if (!command) {
      return {
        available: false,
        error: 'ACP adapter requires a command path or binary name.',
      };
    }

    if ((command.includes('/') || command.includes('\\')) && existsSync(command)) {
      return { available: true, path: command };
    }

    const env = { ...process.env, ...this.getConfig().env };
    const pathResolver = process.platform === 'win32' ? 'where' : 'which';
    const whichResult = spawnSync(pathResolver, [command], {
      encoding: 'utf8',
      ...buildCliSpawnOptions(env),
    });
    if (whichResult.status === 0) {
      return {
        available: true,
        path: whichResult.stdout.trim() || undefined,
      };
    }

    return {
      available: false,
      error: `ACP agent command '${command}' was not found on PATH.`,
    };
  }

  async spawn(): Promise<number> {
    if (this.process && this.initialized) {
      return this.getPid() ?? -1;
    }

    await super.initialize();

    // Acquire a provider concurrency slot BEFORE creating the subprocess.
    // Blocks (FIFO) when the per-provider cap is saturated. On any spawn
    // failure path below, release via releaseConcurrencySlot() so we don't
    // leak slots and stall future spawns indefinitely.
    if (this.acpConfig.concurrencyLimiter && this.acpConfig.concurrencyKey) {
      const key = this.acpConfig.concurrencyKey;
      try {
        this.concurrencyRelease = await this.acpConfig.concurrencyLimiter.acquire(key);
      } catch (error) {
        logger.warn('ACP concurrency acquire failed; spawning without gate', {
          adapter: this.getName(),
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      this.process = this.spawnProcess([]);
    } catch (error) {
      this.releaseConcurrencySlot();
      throw error;
    }
    this.attachProcessListeners();

    try {
      const initializeParams: AcpInitializeParams = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: this.acpConfig.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: this.acpConfig.clientInfo ?? DEFAULT_CLIENT_INFO,
      };
      const initializeResult = await this.sendRequest<AcpInitializeResult>('initialize', initializeParams);
      this.agentCapabilities = initializeResult.agentCapabilities ?? null;

      if ((initializeResult.authMethods?.length ?? 0) > 0) {
        logger.debug('ACP agent advertised auth methods during initialize', {
          adapter: this.getName(),
          authMethodCount: initializeResult.authMethods?.length ?? 0,
        });
      }

      if (initializeResult.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(
          `Unsupported ACP protocol version ${initializeResult.protocolVersion}; expected ${ACP_PROTOCOL_VERSION}.`,
        );
      }

      const sessionId = await this.openSession();
      this.setSessionId(sessionId);
      this.initialized = true;
      this.emit('status', 'ready');

      return this.getPid() ?? -1;
    } catch (error) {
      await this.terminate(false);
      throw error;
    }
  }

  async sendInput(message: string, attachments?: FileAttachment[]): Promise<void> {
    const cliAttachments: AdapterCliAttachment[] | undefined = attachments?.map((attachment) => ({
      type: attachment.type.startsWith('image/') ? 'image' : 'file',
      content: attachment.data,
      mimeType: attachment.type,
      name: attachment.name,
    }));

    try {
      await this.sendMessage({
        role: 'user',
        content: message,
        attachments: cliAttachments,
      });
    } catch (error) {
      // Surface failures as an `error` OutputMessage + `status: error` event
      // (matching the CopilotCliAdapter contract). Without this, a thrown
      // error from sendMessage — e.g. "already has a prompt turn in flight"
      // when the user types while a turn is still running — was silently
      // swallowed by the caller and the UI kept showing "Processing…".
      const err = error instanceof Error ? error : new Error(String(error));
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: err.message,
        metadata: {
          source: 'acp-send-input',
          transport: 'acp',
          adapter: this.getName(),
        },
      };
      this.emit('output', errorMessage);
      this.emit('status', 'error');
      this.emit('error', err);
    }
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    if (message.role !== 'user') {
      throw new Error('ACP adapter only supports user-initiated prompt turns.');
    }

    if (!this.initialized || !this.process) {
      await this.spawn();
    }

    if (!this.sessionId) {
      throw new Error('ACP session has not been initialized.');
    }

    if (this.currentPromptRequestId) {
      throw new Error(
        'Cannot send message: the previous turn is still running. ' +
        'Wait for it to finish, or cancel/interrupt the current turn first.',
      );
    }

    const promptParams: AcpSessionPromptParams = {
      sessionId: this.sessionId,
      prompt: this.toPromptBlocks(message),
    };

    const responseId = this.generateResponseId();
    this.currentPrompt = {
      responseId,
      startedAt: Date.now(),
      chunks: [],
      messageChunksById: new Map<string, string[]>(),
    };
    this.emit('status', 'busy');
    this.armStallWatchdog();

    try {
      const result = await this.sendRequest<AcpSessionPromptResult>('session/prompt', promptParams);
      const turn = this.currentPrompt;
      const duration = turn ? Date.now() - turn.startedAt : 0;
      const usage = this.toCliUsage(result.usage, duration);
      const response: CliResponse = {
        id: turn?.responseId ?? responseId,
        role: 'assistant',
        content: turn?.chunks.join('') ?? '',
        usage,
        metadata: {
          stopReason: result.stopReason,
        },
      };

      this.emit('status', 'idle');
      this.emit('complete', response);
      return response;
    } finally {
      this.currentPrompt = null;
      this.currentPromptRequestId = null;
      this.clearStallWatchdog();
    }
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    const response = await this.sendMessage(message);
    if (response.content) {
      yield response.content;
    }
  }

  parseOutput(raw: string): CliResponse {
    return {
      id: this.generateResponseId(),
      role: 'assistant',
      content: raw,
      metadata: { transport: 'acp' },
    };
  }

  // ACP agents are launched without a message-specific argv contract.
  // Prompt turns are delivered over JSON-RPC once the stdio transport is up.
  protected buildArgs(message: CliMessage): string[] {
    void message;
    return [];
  }

  override async terminate(graceful = true): Promise<void> {
    if (this.sessionId && this.currentPromptRequestId) {
      await this.cancelCurrentPrompt();
    }

    await this.cancelPendingPermissionRequests();
    this.rejectPendingRequests(new Error('ACP adapter terminated before the request completed.'));
    this.clearStallWatchdog();
    this.initialized = false;
    this.currentPrompt = null;
    this.currentPromptRequestId = null;
    this.systemPromptSent = false;
    this.toolCalls.clear();
    this.stdoutBuffer = '';
    await super.terminate(graceful);
    // Release after super.terminate so ordering is: cancel → drain → kill →
    // free slot for the next queued spawn. Safe to call even without a
    // prior acquire (it's idempotent + null-guarded).
    this.releaseConcurrencySlot();
  }

  /**
   * Release the provider concurrency slot held by this adapter, if any.
   * Idempotent — callable from any exit path without double-release risk.
   */
  private releaseConcurrencySlot(): void {
    if (!this.concurrencyRelease) return;
    try {
      this.concurrencyRelease();
    } catch (error) {
      logger.warn('ACP concurrency release threw; ignoring', {
        adapter: this.getName(),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.concurrencyRelease = null;
  }

  // ============ Stall Watchdog ============

  /**
   * Start the stall watchdog for the current prompt turn. Does nothing
   * when `stallWarningMs` is 0 (explicit opt-out) or when no prompt is
   * currently in flight.
   */
  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    this.stallWarningEmitted = false;
    const timeoutMs = this.acpConfig.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
    if (timeoutMs <= 0) return;

    this.stallTimer = setTimeout(() => {
      // Guard: if the turn already settled between timer fire and this tick,
      // don't emit a spurious warning.
      if (!this.currentPromptRequestId || this.stallWarningEmitted) return;
      this.stallWarningEmitted = true;

      const durationMs = this.currentPrompt
        ? Date.now() - this.currentPrompt.startedAt
        : timeoutMs;

      logger.warn('ACP prompt turn appears stalled', {
        adapter: this.getName(),
        sessionId: this.sessionId,
        promptRequestId: this.currentPromptRequestId,
        timeoutMs,
        durationMs,
      });

      // Emit a structured warning the UI can render as "This turn looks
      // stuck — cancel?" without forcibly failing the prompt.
      this.emit('stall_warning', {
        adapter: this.getName(),
        sessionId: this.sessionId,
        promptRequestId: this.currentPromptRequestId,
        timeoutMs,
        durationMs,
      });

      // Also land it on the output buffer so chat history records the
      // stall event and the child-exit summary picks it up.
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `This turn hasn't produced any output for ${Math.round(timeoutMs / 1000)}s — it may be stuck. Cancel the turn to try again.`,
        metadata: {
          source: 'acp-stall-warning',
          transport: 'acp',
          adapter: this.getName(),
          severity: 'warning',
          timeoutMs,
          durationMs,
        },
      } satisfies OutputMessage);
    }, timeoutMs);

    if (typeof this.stallTimer.unref === 'function') {
      this.stallTimer.unref();
    }
  }

  /**
   * Reset the stall watchdog — called when we receive a `session/update`.
   * Equivalent to rearming from scratch (so repeated activity keeps the
   * watchdog silent) while preserving the "already emitted" flag so we
   * don't re-fire immediately on a single update that barely beats the
   * deadline.
   */
  private resetStallWatchdog(): void {
    if (!this.currentPromptRequestId) return;
    this.armStallWatchdog();
  }

  /**
   * Clear the stall watchdog. Called at turn completion and on terminate.
   */
  private clearStallWatchdog(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  override interrupt(): boolean {
    if (!this.sessionId || !this.currentPromptRequestId) {
      return false;
    }

    void this.cancelCurrentPrompt();
    return true;
  }

  async sendRaw(response: string, permissionKey?: string): Promise<void> {
    const pending = this.resolvePendingPermissionRequest(permissionKey);
    if (!pending) {
      throw new Error('No pending ACP permission request is waiting for a response.');
    }

    const outcome = this.selectPermissionOutcome(pending, response, permissionKey);
    await this.sendResponse(pending.rpcId, { outcome });
    this.pendingPermissionRequests.delete(pending.key);
    this.emit('status', 'busy');
  }

  private attachProcessListeners(): void {
    if (!this.process) {
      return;
    }

    this.process.stdout?.setEncoding('utf8');
    this.process.stderr?.setEncoding('utf8');

    this.process.stdout?.on('data', (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });

    this.process.stderr?.on('data', (chunk: string) => {
      logger.debug('ACP stderr', { chunk: chunk.trim() });
    });

    this.process.on('error', (error) => {
      this.rejectPendingRequests(toError(error, 'ACP transport error'));
      this.emit('error', toError(error, 'ACP transport error'));
    });

    this.process.on('exit', (code, signal) => {
      this.initialized = false;
      this.currentPromptRequestId = null;
      this.currentPrompt = null;
      this.rejectPendingRequests(new Error(`ACP agent exited (${code ?? 'null'}${signal ? `/${signal}` : ''}).`));
      this.pendingPermissionRequests.clear();
      this.clearStallWatchdog();
      // Free the concurrency slot so queued spawns can proceed even when the
      // agent dies without us calling terminate() (crash, EXC_BAD_ACCESS,
      // parent SIGKILL, etc.).
      this.releaseConcurrencySlot();
      this.emit('exit', code, signal);
    });
  }

  private async openSession(): Promise<string> {
    if (this.acpConfig.resume) {
      if (!this.acpConfig.sessionId) {
        throw new Error('ACP resume requires a sessionId.');
      }
      if (!this.agentCapabilities?.loadSession) {
        throw new Error('ACP agent does not advertise loadSession support.');
      }
      const loadParams: AcpSessionLoadParams = {
        sessionId: this.acpConfig.sessionId,
        cwd: this.acpConfig.workingDirectory,
        mcpServers: this.acpConfig.mcpServers ?? [],
      };
      await this.sendRequest<null>('session/load', loadParams);
      return this.acpConfig.sessionId;
    }

    const newParams: AcpSessionNewParams = {
      cwd: this.acpConfig.workingDirectory,
      mcpServers: this.acpConfig.mcpServers ?? [],
    };
    const result = await this.sendRequest<AcpSessionNewResult>('session/new', newParams);
    return result.sessionId;
  }

  private async cancelCurrentPrompt(): Promise<void> {
    if (!this.sessionId || !this.currentPromptRequestId) {
      return;
    }

    const cancelledRequestId = this.currentPromptRequestId;

    // Notify the agent so it can tear down cleanly if it's still alive.
    // Best-effort: if stdin is already closed, we still want to reject the
    // local promise below so the caller unblocks.
    try {
      await this.sendNotification('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      logger.debug('ACP session/cancel notification failed; continuing with local cleanup', {
        adapter: this.getName(),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.cancelPendingPermissionRequests();

    // Locally reject the in-flight session/prompt promise and purge it from
    // pendingRequests. Previously cancel was a fire-and-forget notification —
    // if the agent ignored it, `sendMessage` stayed pending forever.
    const pending = this.pendingRequests.get(cancelledRequestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(cancelledRequestId);
      pending.reject(new Error('ACP prompt turn was cancelled by the client.'));
    }
    if (this.currentPromptRequestId === cancelledRequestId) {
      this.currentPromptRequestId = null;
    }
  }

  private async cancelPendingPermissionRequests(): Promise<void> {
    const pending = [...this.pendingPermissionRequests.values()];
    await Promise.all(
      pending.map(async (request) => {
        try {
          await this.sendResponse(request.rpcId, { outcome: { outcome: 'cancelled' } });
        } catch (error) {
          logger.debug('Failed to cancel ACP permission request during cleanup', {
            key: request.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    this.pendingPermissionRequests.clear();
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      if (!rawLine.trim()) {
        continue;
      }

      this.handleMessageLine(rawLine);
    }
  }

  private handleMessageLine(rawLine: string): void {
    let parsed: AcpJsonRpcMessage;

    try {
      parsed = JSON.parse(rawLine) as AcpJsonRpcMessage;
    } catch (error) {
      this.emit('error', new Error(`Failed to parse ACP JSON-RPC line: ${(error as Error).message}`));
      return;
    }

    if (isAcpJsonRpcSuccessResponse(parsed)) {
      this.handleSuccessResponse(parsed);
      return;
    }

    if (isAcpJsonRpcErrorResponse(parsed)) {
      this.handleErrorResponse(parsed);
      return;
    }

    if (isAcpJsonRpcRequest(parsed)) {
      void this.handleInboundRequest(parsed);
      return;
    }

    if (isAcpJsonRpcNotification(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    void this.sendErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid ACP JSON-RPC message.');
  }

  private handleSuccessResponse(response: AcpJsonRpcSuccessResponse): void {
    const key = String(response.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      logger.debug('Ignoring ACP success response for unknown id', { id: key });
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(key);
    pending.resolve(response.result);
  }

  private handleErrorResponse(response: AcpJsonRpcErrorResponse): void {
    const key = response.id == null ? '' : String(response.id);
    const pending = key ? this.pendingRequests.get(key) : undefined;
    const error = new Error(
      `ACP ${pending?.method ?? 'request'} failed: ${response.error.message} (${response.error.code})`,
    );

    if (pending && key) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(key);
      pending.reject(error);
      return;
    }

    this.emit('error', error);
  }

  private async handleInboundRequest(request: AcpJsonRpcRequest): Promise<void> {
    switch (request.method) {
      case 'session/request_permission':
        await this.handlePermissionRequest(request as AcpJsonRpcRequest<AcpSessionRequestPermissionParams>);
        return;
      case 'elicitation/create':
        this.handleElicitationRequest(request as AcpJsonRpcRequest<AcpElicitationCreateParams>);
        return;
      default:
        await this.sendErrorResponse(request.id, JSON_RPC_METHOD_NOT_FOUND, `Unsupported ACP client method '${request.method}'.`);
    }
  }

  private handleNotification(notification: AcpJsonRpcNotification): void {
    switch (notification.method) {
      case 'session/update':
        this.handleSessionUpdate(notification.params as AcpSessionUpdateNotificationParams);
        return;
      case 'elicitation/complete':
        this.handleElicitationComplete(notification.params as AcpElicitationCompleteParams);
        return;
      default:
        logger.debug('Ignoring ACP notification', { method: notification.method });
    }
  }

  private handleSessionUpdate(params: AcpSessionUpdateNotificationParams): void {
    if (!this.sessionId || params.sessionId !== this.sessionId) {
      return;
    }

    // Any inbound session/update resets the stall watchdog — the agent is
    // clearly still alive even if individual updates take a while. We do
    // this up front so the reset applies even to updates we don't have a
    // specific handler branch for below.
    this.resetStallWatchdog();

    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        this.handleMessageChunk(update);
        break;
      case 'tool_call':
        this.handleToolCallCreated(update);
        break;
      case 'tool_call_update':
        this.handleToolCallDelta(update);
        break;
      case 'plan':
        this.emitStructuredOutput('system', this.renderPlan(update), {
          sessionUpdate: update.sessionUpdate,
          entries: update.entries,
        });
        break;
      case 'available_commands_update':
        this.emitStructuredOutput('system', this.renderAvailableCommands(update), {
          sessionUpdate: update.sessionUpdate,
          commands: update.commands,
        });
        break;
      case 'config_option_update':
      case 'session_info_update':
        this.emitStructuredOutput('system', JSON.stringify(update), { sessionUpdate: update.sessionUpdate });
        break;
      default:
        logger.debug('Ignoring ACP session update variant', {
          sessionUpdate: (update as AcpSessionUpdate).sessionUpdate,
        });
    }
  }

  private handleMessageChunk(update: Extract<AcpSessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'user_message_chunk' }>): void {
    const content = this.extractContentText(update.content);
    if (!content) {
      return;
    }

    const messageType = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'user';
    const turn = this.currentPrompt;
    const messageId = update.messageId ?? turn?.responseId ?? generateId();
    let accumulatedContent = content;

    if (turn) {
      const messageChunks = turn.messageChunksById.get(messageId) ?? [];
      messageChunks.push(content);
      turn.messageChunksById.set(messageId, messageChunks);
      accumulatedContent = messageChunks.join('');

      if (update.sessionUpdate === 'agent_message_chunk') {
        turn.chunks.push(content);
      }
    }

    this.emit('output', {
      id: messageId,
      timestamp: Date.now(),
      type: messageType,
      content: accumulatedContent,
      metadata: {
        sessionUpdate: update.sessionUpdate,
        transport: 'acp',
        streaming: true,
        accumulatedContent,
      },
    } satisfies OutputMessage);
  }

  private handleToolCallCreated(update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>): void {
    const observed: AcpObservedToolCall = {
      id: update.toolCallId,
      title: update.title,
      kind: update.kind ?? 'other',
      status: update.status ?? 'pending',
      rawInput: update.rawInput,
    };
    this.toolCalls.set(update.toolCallId, observed);

    const toolCall: CliToolCall = {
      id: update.toolCallId,
      name: update.title,
      arguments: {
        kind: observed.kind,
        ...(update.rawInput ? { rawInput: update.rawInput } : {}),
      },
    };
    this.emit('tool_use', toolCall);
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: update.title,
      metadata: {
        toolCallId: update.toolCallId,
        kind: observed.kind,
        // Expose `name` so the renderer's ActivityDebouncer
        // (instance.store.ts) picks up the tool and shows the "Searching the
        // codebase", "Making edits", etc. progress indicator for ACP agents
        // (Copilot, Cursor) the same way it does for Claude. We surface the
        // ACP `kind` as the name because it's a stable enum that the
        // TOOL_ACTIVITY_MAP can key on — `title` is a free-form human
        // description that changes per call.
        name: observed.kind,
        title: observed.title,
        status: observed.status,
        transport: 'acp',
      },
    } satisfies OutputMessage);
  }

  private handleToolCallDelta(update: AcpToolCallDeltaUpdate): void {
    const observed = this.toolCalls.get(update.toolCallId);
    const title = update.title ?? observed?.title ?? update.toolCallId;
    const kind = update.kind ?? observed?.kind ?? 'other';
    const status = update.status ?? observed?.status ?? 'pending';

    this.toolCalls.set(update.toolCallId, {
      id: update.toolCallId,
      title,
      kind,
      status,
      rawInput: update.rawInput ?? observed?.rawInput,
    });

    const renderedOutput = this.extractToolOutputText(update.content);
    if (renderedOutput) {
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'tool_result',
        content: renderedOutput,
        metadata: {
          sessionUpdate: update.sessionUpdate,
          toolCallId: update.toolCallId,
          title,
          status,
          transport: 'acp',
        },
      } satisfies OutputMessage);
    }

    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      const toolCall: CliToolCall = {
        id: update.toolCallId,
        name: title,
        arguments: {
          kind,
          ...(update.rawInput ?? observed?.rawInput ? { rawInput: update.rawInput ?? observed?.rawInput } : {}),
        },
        result: renderedOutput,
      };
      this.emit('tool_result', toolCall);
    }
  }

  private async handlePermissionRequest(
    request: AcpJsonRpcRequest<AcpSessionRequestPermissionParams>,
  ): Promise<void> {
    const params = request.params;
    if (!params) {
      await this.sendErrorResponse(request.id, JSON_RPC_INVALID_REQUEST, 'Missing params for session/request_permission.');
      return;
    }

    const key = this.buildPermissionKey(request.id);
    const pending: AcpPendingPermissionRequest = {
      key,
      rpcId: request.id,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? params.toolCall.toolCallId,
      kind: params.toolCall.kind ?? 'other',
      options: params.options,
    };
    this.pendingPermissionRequests.set(key, pending);

    this.emit('status', 'waiting_for_permission');
    this.emit('input_required', {
      id: key,
      prompt: this.buildPermissionPrompt(pending),
      timestamp: Date.now(),
      metadata: {
        type: 'acp_permission_request',
        action: 'acp_permission',
        path: String(request.id),
        toolCallId: pending.toolCallId,
        toolName: pending.title,
        options: params.options,
        transport: 'acp',
      },
    });

    if (this.acpConfig.permissionRegistry && this.acpConfig.permissionContext) {
      const permissionRequest: PermissionRequest = {
        id: key,
        instanceId: this.acpConfig.permissionContext.instanceId,
        childId: this.acpConfig.permissionContext.childId,
        action: pending.kind,
        description: this.buildPermissionPrompt(pending),
        toolName: pending.title,
        details: {
          toolCallId: pending.toolCallId,
          options: pending.options,
          transport: 'acp',
        },
        createdAt: Date.now(),
        timeoutMs: this.acpConfig.permissionRequestTimeoutMs ?? 60_000,
      };

      void this.acpConfig.permissionRegistry.requestPermission(permissionRequest)
        .then(async (decision) => {
          await this.resolvePermissionDecision(pending.key, decision);
        })
        .catch((error) => {
          logger.warn('ACP permission registry resolution failed', {
            key: pending.key,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
  }

  private handleElicitationRequest(request: AcpJsonRpcRequest<AcpElicitationCreateParams>): void {
    const params = request.params;
    const prompt = [
      params?.title,
      params?.description,
      params?.url ? `Open in browser: ${params.url}` : undefined,
      params?.schema ? `Schema: ${JSON.stringify(params.schema)}` : undefined,
    ].filter(Boolean).join('\n\n');

    this.emit('input_required', {
      id: `acp_elicitation:${String(request.id)}`,
      prompt: prompt || 'ACP elicitation request received.',
      timestamp: Date.now(),
      metadata: {
        type: 'acp_elicitation',
        transport: 'acp',
        mode: params?.mode,
        schema: params?.schema,
        url: params?.url,
        elicitationId: params?.elicitationId,
      },
    });
  }

  private handleElicitationComplete(params: AcpElicitationCompleteParams): void {
    this.emitStructuredOutput('system', `ACP elicitation completed: ${params.elicitationId}`, {
      transport: 'acp',
      elicitationId: params.elicitationId,
      type: 'acp_elicitation_complete',
    });
  }

  private async resolvePermissionDecision(key: string, decision: PermissionDecision): Promise<void> {
    const pending = this.pendingPermissionRequests.get(key);
    if (!pending) {
      return;
    }

    const responseText = decision.granted ? 'allow' : 'deny';
    const outcome = this.selectPermissionOutcome(pending, responseText, key);
    await this.sendResponse(pending.rpcId, { outcome });
    this.pendingPermissionRequests.delete(key);
    this.emit('status', 'busy');
  }

  private emitStructuredOutput(
    type: OutputMessage['type'],
    content: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (!content) {
      return;
    }

    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type,
      content,
      metadata,
    } satisfies OutputMessage);
  }

  private extractContentText(content: AcpContentBlock): string {
    if (content.type === 'text') {
      return content.text;
    }

    if (content.type === 'image') {
      return content.uri ? `[Image attachment: ${content.uri}]` : '[Image attachment]';
    }

    if (content.resource.text) {
      return content.resource.text;
    }

    return content.resource.title || content.resource.uri;
  }

  private extractToolOutputText(items?: AcpToolCallOutputItem[]): string {
    if (!items || items.length === 0) {
      return '';
    }

    return items
      .map((item) => this.extractContentText(item.content))
      .filter(Boolean)
      .join('\n');
  }

  private renderPlan(update: AcpPlanUpdate): string {
    const lines = update.entries.map((entry) => {
      const parts = [entry.status, entry.priority].filter(Boolean).join(' / ');
      return parts ? `- ${entry.content} (${parts})` : `- ${entry.content}`;
    });
    return ['Plan:', ...lines].join('\n');
  }

  private renderAvailableCommands(update: AcpAvailableCommandsUpdate): string {
    const lines = update.commands.map((command) =>
      command.description ? `- ${command.name}: ${command.description}` : `- ${command.name}`,
    );
    return ['Available commands:', ...lines].join('\n');
  }

  private buildPermissionPrompt(pending: AcpPendingPermissionRequest): string {
    const lines = pending.options.map((option) => `- ${option.name}`);
    return [
      `ACP agent requests permission to continue tool execution.`,
      `Tool: ${pending.title}`,
      `Kind: ${pending.kind}`,
      'Options:',
      ...lines,
    ].join('\n');
  }

  private resolvePendingPermissionRequest(permissionKey?: string): AcpPendingPermissionRequest | undefined {
    if (permissionKey) {
      if (this.pendingPermissionRequests.has(permissionKey)) {
        return this.pendingPermissionRequests.get(permissionKey);
      }

      const derived = this.buildPermissionKey(permissionKey);
      if (this.pendingPermissionRequests.has(derived)) {
        return this.pendingPermissionRequests.get(derived);
      }
    }

    if (this.pendingPermissionRequests.size === 1) {
      return this.pendingPermissionRequests.values().next().value;
    }

    return undefined;
  }

  private selectPermissionOutcome(
    pending: AcpPendingPermissionRequest,
    response: string,
    permissionKey?: string,
  ): AcpSessionRequestPermissionOutcome {
    const normalized = slug(response);

    if (!normalized || normalized === 'cancel') {
      return { outcome: 'cancelled' };
    }

    const directOptionId = permissionKey && pending.options.find((option) =>
      option.optionId === permissionKey || this.buildPermissionKey(option.optionId) === permissionKey,
    );
    if (directOptionId) {
      return { outcome: 'selected', optionId: directOptionId.optionId };
    }

    const matchedByIdOrLabel = pending.options.find((option) =>
      slug(option.optionId) === normalized || slug(option.name) === normalized || normalized.includes(slug(option.name)),
    );
    if (matchedByIdOrLabel) {
      return { outcome: 'selected', optionId: matchedByIdOrLabel.optionId };
    }

    const allowOption = pending.options.find((option) => option.kind.startsWith('allow'));
    const rejectOption = pending.options.find((option) => option.kind.startsWith('reject'));

    if (
      normalized.startsWith('y')
      || normalized.includes('allow')
      || normalized.includes('approve')
      || normalized.includes('grant')
    ) {
      if (allowOption) {
        return { outcome: 'selected', optionId: allowOption.optionId };
      }
    }

    if (
      normalized.startsWith('n')
      || normalized.includes('deny')
      || normalized.includes('reject')
      || normalized.includes('decline')
    ) {
      if (rejectOption) {
        return { outcome: 'selected', optionId: rejectOption.optionId };
      }
      return { outcome: 'cancelled' };
    }

    if (allowOption) {
      return { outcome: 'selected', optionId: allowOption.optionId };
    }

    if (pending.options[0]) {
      return { outcome: 'selected', optionId: pending.options[0].optionId };
    }

    return { outcome: 'cancelled' };
  }

  private buildPermissionKey(id: AcpJsonRpcId | string): string {
    return `acp_permission:${String(id)}`;
  }

  private toPromptBlocks(message: CliMessage): AcpContentBlock[] {
    const prompt: AcpContentBlock[] = [];

    if (!this.acpConfig.resume && !this.systemPromptSent && this.acpConfig.systemPrompt?.trim()) {
      const systemPrompt = this.acpConfig.systemPrompt.trim();
      if (systemPrompt.length <= AcpCliAdapter.MAX_SYSTEM_PROMPT_CHARS) {
        prompt.push({
          type: 'text',
          text: ['[SYSTEM INSTRUCTIONS]', systemPrompt, '[/SYSTEM INSTRUCTIONS]'].join('\n'),
        });
      }
      this.systemPromptSent = true;
    }

    if (message.content) {
      prompt.push({ type: 'text', text: message.content });
    }

    for (const attachment of message.attachments ?? []) {
      const block = this.toPromptBlockFromAttachment(attachment);
      if (block) {
        prompt.push(block);
      }
    }

    return prompt;
  }

  private toPromptBlockFromAttachment(attachment: AdapterCliAttachment): AcpContentBlock | null {
    const inlineContent = attachment.content
      ?? (attachment.path?.startsWith('data:') ? attachment.path : undefined);
    if (inlineContent) {
      const parsedDataUrl = parseDataUrl(inlineContent);
      const mimeType = attachment.mimeType?.trim() || parsedDataUrl?.mimeType;
      const base64Data = parsedDataUrl?.base64Data ?? stripDataUrlPrefix(inlineContent);

      if (mimeType?.startsWith('image/')) {
        return {
          type: 'image',
          data: base64Data,
          mimeType,
          uri: buildAttachmentUri(attachment.name),
        };
      }

      if (parsedDataUrl || !isTextLikeMimeType(mimeType)) {
        return {
          type: 'resource',
          resource: {
            uri: buildAttachmentUri(attachment.name),
            mimeType,
            blob: base64Data,
            title: attachment.name,
          },
        };
      }

      return {
        type: 'resource',
        resource: {
          uri: buildAttachmentUri(attachment.name),
          mimeType,
          text: inlineContent,
          title: attachment.name,
        },
      };
    }

    if (attachment.path) {
      const resourceUri = attachment.path.startsWith('file://')
        ? attachment.path
        : pathToFileURL(attachment.path).toString();
      return {
        type: 'resource',
        resource: {
          uri: resourceUri,
          mimeType: attachment.mimeType,
          text: attachment.content,
          title: attachment.name,
        },
      };
    }

    return null;
  }

  private toCliUsage(usage: AcpPromptUsage | undefined, duration: number) {
    if (!usage) {
      return duration > 0 ? { duration } : undefined;
    }

    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      cost: usage.costUsd,
      duration,
    };
  }

  private async sendRequest<TResult>(method: string, params?: unknown): Promise<TResult> {
    if (!this.process) {
      throw new Error(`Cannot send ACP request '${method}' before the process is spawned.`);
    }

    const id = String(++this.requestCounter);
    const request: AcpJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    // Per-method timeout: prompt turns get a loose ceiling; all other RPCs
    // use the default. Without a timeout, a silently dead agent would leave
    // this promise pending forever (root cause of the "Processing…" hang).
    const timeoutMs = method === 'session/prompt'
      ? this.acpConfig.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
      : this.acpConfig.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const responsePromise = new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only act if this pending entry is still the live one; resolve()
        // and reject() paths both clear the timer before settling.
        const entry = this.pendingRequests.get(id);
        if (!entry) return;
        this.pendingRequests.delete(id);
        if (this.currentPromptRequestId === id) {
          this.currentPromptRequestId = null;
        }
        const error = new Error(
          `ACP ${method} request timed out after ${timeoutMs}ms (id=${id}). ` +
          'The agent may be stuck on an orphaned tool call or permission request.',
        );
        logger.warn('ACP request timeout', {
          adapter: this.getName(),
          method,
          id,
          timeoutMs,
        });
        reject(error);
      }, timeoutMs);
      // Let the event loop exit even if this timer is still armed (e.g.,
      // during process shutdown); terminate() also explicitly clears it.
      if (typeof timer.unref === 'function') {
        timer.unref();
      }

      this.pendingRequests.set(id, {
        method,
        resolve: (value) => resolve(value as TResult),
        reject,
        timer,
      });
    });

    if (method === 'session/prompt') {
      this.currentPromptRequestId = id;
    }

    await this.safeStdinWrite(`${ndjsonSafeStringify(request)}\n`);
    return responsePromise;
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: AcpJsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.safeStdinWrite(`${ndjsonSafeStringify(notification)}\n`);
  }

  private async sendResponse(id: AcpJsonRpcId, result: unknown): Promise<void> {
    const response: AcpJsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    await this.safeStdinWrite(`${ndjsonSafeStringify(response)}\n`);
  }

  private async sendErrorResponse(id: AcpJsonRpcId | null, code: number, message: string): Promise<void> {
    const response: AcpJsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    await this.safeStdinWrite(`${ndjsonSafeStringify(response)}\n`);
  }
}
