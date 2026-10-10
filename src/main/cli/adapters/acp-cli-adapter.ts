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
import {
  BaseCliAdapter,
  type AdapterInputDispatch,
  type AdapterRuntimeCapabilities,
  type CliAdapterConfig,
  type CliAttachment as AdapterCliAttachment,
  type CliCapabilities,
  type InterruptResult,
  type TurnInterruptCompletion,
  type CliMessage,
  type CliResponse,
  type CliSpawnMode,
  type CliStatus,
  type CliToolCall,
  type ResumeAttemptResult,
  ndjsonSafeStringify,
} from './base-cli-adapter';
import { StderrTailBuffer } from './acp-stderr-tail';
import { AcpNdjsonFramer } from './acp-ndjson-framer';
import { acpTextDiagnostic, safeAcpProtocolDetails } from './acp-protocol-diagnostics';
import { assertAdapterInputCurrent, createAdapterInputDispatch } from './adapter-input-dispatch';
import { isStdinWriteProcessError } from './child-stdin-write';
import { assertAcpGenerationBudgetSelection, isAcpSessionModelConfirmed } from './acp-generation-budget-selection';
import { reduceAcpSessionConfigResponse, type AcpSessionResponseRequest } from './acp-session-config-response';
import { ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE, isAcpPromptRequestTimeout, isAcpPromptCancelledByClient,
  isAcpActiveTurnCollision, isAcpAgentExitRejection, isAcpInputWriteFailure, markAcpInputWriteFailure, normalizeAcpInputWriteError } from './acp-prompt-errors';
import { AcpDelegatedTaskLiveness, type AcpChildProgressSource } from './acp-delegated-task-liveness';
import { DOOM_LOOP_BLOCKED_NOTICE, resolveAcpAutomaticPermission } from './acp-doom-loop-permission';
import { filterSessionMcpServers } from './acp-session-mcp-servers';
import { getLogger } from '../../logging/logger';
import { safeDiagnosticNumber } from '../turn-ending-diagnostic-fields';
import { generateId } from '../../../shared/utils/id-generator';
import {
  buildAcpContextUsageEvent,
  estimateAcpCliUsage,
  toAcpCliUsage,
} from './acp-usage-estimator';
import type { FileAttachment, OutputMessage } from '../../../shared/types/instance.types';
import type {
  AcpAgentCapabilities,
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
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import type { ProviderConcurrencyLimiter } from '../provider-concurrency-limiter';
import { toAcpPromptBlockFromAttachment } from './acp-attachment-blocks';
import { withPersistedAcpImageAttachments } from './acp-attachment-store';
import {
  appendAcpAssistantDelta,
  collectAcpAssistantFlushes,
  createAcpAssistantTurn,
  normalizeAcpAssistantDelta,
  resolveAcpChunkTurn,
  type AcpAssistantTurnState,
} from './acp-assistant-stream';
import {
  AcpStallWatchdog,
  buildAcpStallContext,
  buildAcpStallOutputMessage,
  type AcpStallReport,
} from './acp-stall-watchdog';
import {
  DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
  DEFAULT_DELEGATED_TASK_TIMEOUT_MS,
  classifyAcpTurnWait,
  describeAcpPromptTimeoutCause,
  hasActiveAcpToolCall,
  isDelegatedAcpTask,
  isBackgroundAcpTask,
  resolveAcpPromptLeaseMs,
  selectCurrentTurnPermissions,
  type AcpTurnWaitKind,
  type AcpTurnWait,
} from './acp-prompt-timeout-policy';
import { classifyMissingUsage } from './acp-transport-failure';
import { buildRetryRecoveredMessage, buildRetryStateMessage } from './acp-retry-state';
import { buildAcpElicitationResponse } from './acp-elicitation-response';
import { applyAcpSessionConfig, type AcpSessionConfigRequest } from './acp-session-config-options';
import { confirmAcpLiveSessionConfig, isAcpSessionConfigSelected } from './acp-session-config-confirmation';
import { AcpSessionCostLedger, buildAcpMeasuredContextEvent, parseAcpUsageUpdate } from './acp-usage-update';
import { appendAcpThoughtDelta, buildAcpTurnThinking } from './acp-thought-stream';
import { buildAcpTurnCompletion } from './acp-turn-completion';
import { classifyTurnEnding } from '../turn-ending-classifier';
import { settleAcpErrorResponse } from './acp-jsonrpc-errors';
import type { AcpStartupGate } from './acp-startup-gate';
import { tagAcpProviderLimit } from './acp-provider-limit';
import { normalizeAcpAvailableCommands, renderAcpPlan } from './acp-session-update-normalizers';
import {
  buildAcpMinableInput, buildAcpToolCallArguments, buildAcpToolOutcomeFallback, buildAcpToolResultMessage,
  isAcpTerminalToolStatus, renderAcpRawOutput,
} from './acp-tool-call-material';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
const logger = getLogger('AcpCliAdapter');

const ACP_PROTOCOL_VERSION = 1;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_REQUEST = -32600;

/**
 * Normalize an ACP `currentModelId` (attribute form) to a bare model id.
 *
 * Cursor reports models like `composer-2.5[fast=true]` or
 * `claude-opus-5[thinking=true,effort=high]`; strip the `[...]` attribute
 * block. Cursor's Auto sentinel is reported as `default` — map it back to our
 * `auto` id. Returns undefined for empty/missing input.
 *
 * NOTE: the stripped form (`claude-opus-5`) intentionally does NOT always
 * equal a `--list-models` id (`claude-opus-5-thinking-high`); callers must
 * only apply it where that divergence is acceptable (see the cursor `model`
 * handler, which reconciles only the `auto` case).
 */
export function normalizeAcpModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const stripped = raw.replace(/\[.*\]\s*$/, '').trim();
  if (!stripped) return undefined;
  return stripped === 'default' ? 'auto' : stripped;
}

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
 * The activity-aware prompt timeout is still the authoritative ACP liveness
 * owner; the stall watchdog only narrates the wait. Off unless a caller opts
 * in — `adapter-factory` supplies the real interval via
 * `resolveAcpStallWarningMs`, so this default only covers direct construction
 * and tests.
 *
 * The old reason for leaving it off everywhere was that legitimate
 * remote/browser work can stay quiet for minutes and a transcript error would
 * tell users to cancel healthy work. That is now addressed by what the warning
 * *says* rather than by staying silent: it names the tool call or permission
 * request being waited on, and only claims the turn may be stuck when nothing
 * owns the silence. Suppressing instead would hide an agent that died holding
 * a `pending` tool call until the 60-minute `activeToolTimeoutMs` lease.
 */
const DEFAULT_STALL_WARNING_MS = 0;

const DEFAULT_CLIENT_INFO: AcpImplementationInfo = {
  name: 'ai-orchestrator',
  title: 'Harness',
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

interface AcpPendingRequest extends AcpSessionResponseRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Timer that rejects the pending promise if the agent never replies.
   *  Cleared on any settle path (resolve, reject, cancel, terminate). */
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

interface AcpObservedToolCall {
  id: string;
  title: string;
  kind: AcpToolKind;
  status: AcpToolCallStatus;
  delegatedTask?: boolean;
  rawInput?: Record<string, unknown>;
  /** Latest output snapshot of an unsettled call, emitted once it settles. */
  pendingOutput?: string;
  /** Position of this call's output in the turn's `toolActivityChunks`. */
  outputChunkIndex?: number;
}

type AcpPendingPromptTurn = AcpAssistantTurnState & { writePhase?: { accepted: boolean; cancelledByClient?: boolean } };
interface AcpPendingPermissionRequest {
  key: string;
  rpcId: AcpJsonRpcId;
  sessionId: string;
  toolCallId?: string;
  title: string;
  kind: AcpToolKind;
  options: AcpPermissionOption[];
  /** When the request arrived. `pendingPermissionRequests` is not cleared at
   *  turn boundaries (a failed `sendResponse` write leaks the entry), so the
   *  turn diagnosis filters on this rather than blaming a dead turn's request. */
  createdAt: number;
}

interface AcpPendingElicitationRequest {
  key: string;
  rpcId: AcpJsonRpcId;
  params?: AcpElicitationCreateParams;
}

export interface AcpCliAdapterConfig extends Omit<CliAdapterConfig, 'command' | 'cwd'> {
  adapterName?: string;
  contextCapabilityProfile?: 'copilot-acp';
  /** ACP authentication method to invoke after initialize and before opening
   *  a session. Provider-scoped opt-in: agents that do not require the ACP
   *  authenticate handshake leave this unset. */
  authMethodId?: string;
  command?: string;
  model?: string;
  systemPrompt?: string;
  /** When true, prepend the RTK awareness prompt on the first turn so the
   *  model prefixes shell commands with `rtk`. ACP-backed providers
   *  (Copilot, Cursor) lack a Claude-style PreToolUse hook surface, so
   *  awareness-via-prompt is the integration point. */
  rtkEnabled?: boolean;
  workingDirectory: string;
  sessionId?: string;
  resume?: boolean;
  mcpServers?: AcpMcpServerConfig[];
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: AcpImplementationInfo;
  permissionRequestTimeoutMs?: number;
  permissionRegistry?: Pick<PermissionRegistry, 'requestPermission'> & Partial<Pick<PermissionRegistry, 'resolve'>>;
  permissionContext?: {
    instanceId: string;
    childId?: string;
    yoloMode?: boolean;
  };
  /** Per-method JSON-RPC timeout override for non-prompt requests.
   *  Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  requestTimeoutMs?: number;
  /** Maximum time to wait for a provider concurrency slot during startup.
   *  Without this, a stale held slot can leave a child permanently
   *  `initializing` before the ACP process is even spawned. */
  concurrencyAcquireTimeoutMs?: number;
  /** Timeout for `session/prompt` RPCs. Prompt turns are long-running so
   *  this is intentionally looser than `requestTimeoutMs`. Defaults to
   *  {@link DEFAULT_PROMPT_TIMEOUT_MS}. */
  promptTimeoutMs?: number;
  /** Inactivity timeout while an ACP tool call is pending or in progress. */
  activeToolTimeoutMs?: number;
  delegatedTaskTimeoutMs?: number;
  childProgressSource?: AcpChildProgressSource;
  /** Provider concurrency gate. When set, `spawn()` will block until a
   *  slot keyed on `concurrencyKey` is available. Prevents unbounded
   *  ACP fan-out (observed: 5+ Copilot children spawned simultaneously,
   *  amplifying the orphaned-tool-call hang). */
  concurrencyLimiter?: Pick<ProviderConcurrencyLimiter, 'acquire'>;
  /** Limiter key — typically the provider name (`'copilot'`, `'cursor'`). */
  concurrencyKey?: string;
  /** `'overflow'` takes reserved extra slots once the interactive cap is full. */
  concurrencyPriority?: 'normal' | 'overflow';
  /** Emit a `stall_warning` event + a `system` OutputMessage if a prompt turn
   *  goes this long without any `session/update` notification. All three ACP
   *  factories set it (`resolveAcpStallWarningMs`); 0 opts out. The
   *  activity-aware prompt timeout remains authoritative — this only narrates
   *  the wait so a long silence is visible before the turn fails. */
  stallWarningMs?: number;
  /** Model/effort applied with `session/set_config_option` once the session
   *  opens (agents with no model flag, e.g. OpenCode). Best effort unless model
   *  confirmation is required for an account route or generation budget. */
  sessionConfig?: AcpSessionConfigRequest;
  /** Refuse startup unless native model selection confirms the routed account. */
  requireSessionModelConfirmation?: boolean;
  /** Held from process spawn until `initialize` answers (see acp-startup-gate.ts). */
  startupGate?: AcpStartupGate;
  /** Gated discovery that must finish before acquiring the non-reentrant startup gate. */
  beforeStartupGate?: () => Promise<void>;
  /** The agent's reported cost is the only cost: a turn without one records
   *  $0 instead of pricing its tokens from a static table (OpenCode fronts
   *  flat-fee and free backends that no price row describes). */
  reportedCostOnly?: boolean;
  /** Materialize provider-specific private launch files and return that spawn's cleanup. */
  prepareSpawn?: () => (() => void) | Promise<() => void>;
  prepareContentFilterRecovery?: (sessionId: string, toolCallId: string, signal?: AbortSignal) => Promise<boolean>;
  generationBudget?: { model: string; combinedOutputTokens: number; reasoningBudgetSupported: false };
  /** Keep a durable copy of each inline image and send its file:// URI. For
   *  agents (Copilot) that otherwise delete their temp copy when the session
   *  closes, which strands the transcript's image paths after hibernation. */
  persistImageAttachments?: boolean;
}

type InputRequiredResolvedReason = 'timeout' | 'auto_approved' | 'decided' | 'cancelled' | 'exited';

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) {
    return value;
  }
  return new Error(typeof value === 'string' ? value : fallback);
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class AcpCliAdapter extends BaseCliAdapter {
  private static readonly MAX_SYSTEM_PROMPT_CHARS = 4000;

  /** B9: ACP speaks JSON-RPC over stdio (Agent Client Protocol). */
  protected override spawnMode: CliSpawnMode = 'acp';
  protected override readonly defersInputDispatch = true;

  private readonly acpConfig: AcpCliAdapterConfig;
  private readonly pendingRequests = new Map<string, AcpPendingRequest>();
  private readonly toolCalls = new Map<string, AcpObservedToolCall>();
  private readonly pendingPermissionRequests = new Map<string, AcpPendingPermissionRequest>();
  private readonly pendingElicitationRequests = new Map<string, AcpPendingElicitationRequest>();
  private readonly stdoutFramer = new AcpNdjsonFramer();
  private get stdoutBuffer(): string { return this.stdoutFramer.pendingText; }
  private requestCounter = 0;
  private initialized = false;
  private agentCapabilities: AcpAgentCapabilities | null = null;
  private currentPrompt: AcpPendingPromptTurn | null = null;
  /** Survives `session/prompt` returning so late `agent_message_chunk` tokens
   *  still upsert the same assistant bubble instead of minting one per token. */
  private recentAssistantTurn: AcpPendingPromptTurn | null = null;
  private currentPromptRequestId: string | null = null;
  private lastResumeAttemptResult: ResumeAttemptResult | undefined;
  private systemPromptSent = false;
  /** Whether RTK awareness has been injected on this session (first turn only). */
  private rtkAwarenessSent = false;
  /** Release function returned by `ProviderConcurrencyLimiter.acquire`.
   *  Set in `spawn()` when concurrency gating is configured, invoked
   *  exactly once on the first of {terminate, exit, spawn-failure}. */
  private concurrencyRelease: (() => void) | null = null;
  /** Stall watchdog timer — fires if a prompt turn receives no
   *  `session/update` for longer than `stallWarningMs`. Rearmed on
   *  every inbound update; cleared when the turn settles. */
  private stallWatchdog: AcpStallWatchdog | null = null;
  /** Wait kinds already surfaced to the transcript for the current turn. */
  private readonly stallKindsNoticed = new Set<AcpTurnWaitKind>();
  private protocolErrorOutputCount = 0;
  /** Latest authoritative options from session responses and configuration notifications. */
  private sessionConfigOptions: unknown;
  private readonly nextPromptContext: string[] = [];
  /** Bounded stderr tail, logged at exit/error so a silent CLI self-shutdown
   *  keeps its trigger (e.g. the raw " Exiting… " signal marker). */
  private readonly stderrTail = new StderrTailBuffer();
  private readonly costLedger = new AcpSessionCostLedger();
  /** True once the agent reported measured occupancy via `usage_update`. */
  private measuredOccupancy = false;
  private spawnCleanup: (() => void) | null = null;
  private readonly delegatedLiveness: AcpDelegatedTaskLiveness;
  private outputBlockedNoticed = false;
  private recentReadToolCallId: string | null = null;

  constructor(config: AcpCliAdapterConfig) {
    super({
      command: config.command ?? 'acp-agent',
      args: config.args,
      cwd: config.workingDirectory,
      timeout: config.timeout,
      env: config.env,
      // Must be forwarded: this field-pick silently dropped it, and since the
      // config type accepts it nothing failed to compile while Copilot's
      // ambient-token strip was a no-op on its default path.
      envRemove: config.envRemove,
      maxRetries: config.maxRetries,
      sessionPersistence: true,
      persistLargeOutputs: config.persistLargeOutputs,
    });
    this.acpConfig = {
      permissionRequestTimeoutMs: 60_000,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
      promptTimeoutMs: DEFAULT_PROMPT_TIMEOUT_MS,
      activeToolTimeoutMs: DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
      delegatedTaskTimeoutMs: DEFAULT_DELEGATED_TASK_TIMEOUT_MS,
      stallWarningMs: DEFAULT_STALL_WARNING_MS,
      ...config,
    };
    this.delegatedLiveness = new AcpDelegatedTaskLiveness(config.childProgressSource, () => {
      this.refreshCurrentPromptTimeout();
      this.emit('heartbeat');
    });
  }

  getName(): string {
    return this.acpConfig.adapterName?.trim() || 'ACP';
  }

  async prepareContentFilterRecovery(signal?: AbortSignal): Promise<boolean> {
    return !signal?.aborted && this.sessionId !== null && this.currentPrompt === null && this.recentReadToolCallId !== null
      && await this.acpConfig.prepareContentFilterRecovery?.(this.sessionId, this.recentReadToolCallId, signal) === true;
  }

  /** Bounded stderr tail — for tests and exit-context diagnostics. */
  getStderrTail(): string | undefined {
    return this.stderrTail.dump();
  }

  getCapabilities(): CliCapabilities {
    return ACP_CAPABILITIES;
  }
  override getAdapterCapabilities() { return { residentSession: true, liveInterrupt: false, liveSteer: false }; }
  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: this.agentCapabilities?.loadSession === true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: true,
      supportsDeferPermission: false,
    };
  }

  override getContextCapabilities(): ProviderContextCapabilities {
    if (this.acpConfig.contextCapabilityProfile !== 'copilot-acp') {
      const base = super.getContextCapabilities();
      return this.measuredOccupancy ? { ...base, occupancyReporting: 'current' } : base;
    }
    return {
      toolResultControl: 'post-retention',
      toolResultVisibility: 'full',
      transcriptControl: 'none',
      occupancyReporting: 'aggregate-only',
      cumulativeReporting: 'available',
      interruptProof: 'none',
      compactionProof: 'none',
      sameThreadContinuation: false,
    };
  }

  getResumeAttemptResult(): ResumeAttemptResult | undefined {
    return this.lastResumeAttemptResult;
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
      const startedAt = Date.now();
      const deadlineAt = this.acpConfig.concurrencyAcquireTimeoutMs !== undefined
        ? startedAt + this.acpConfig.concurrencyAcquireTimeoutMs
        : undefined;
      this.emit('slot:wait-start', { provider: key, startedAt, deadlineAt });
      try {
        this.concurrencyRelease = await this.acpConfig.concurrencyLimiter.acquire(key, {
          timeoutMs: this.acpConfig.concurrencyAcquireTimeoutMs,
          priority: this.acpConfig.concurrencyPriority,
        });
        this.emit('slot:wait-end', { provider: key });
      } catch (error) {
        this.emit('slot:wait-end', { provider: key });
        logger.warn('ACP concurrency acquire failed; refusing ungated spawn', {
          adapter: this.getName(),
          key,
          ...safeAcpProtocolDetails({ error }),
        });
        throw error;
      }
    }

    let releaseStartupGate: (() => void) | undefined;
    try {
      await this.acpConfig.beforeStartupGate?.();
      releaseStartupGate = await this.acpConfig.startupGate?.();
      this.spawnCleanup = await this.acpConfig.prepareSpawn?.() ?? null;
      this.process = this.spawnProcess([]);
    } catch (error) {
      try { this.spawnCleanup?.(); }
      catch (cleanupError) { logger.warn('ACP failed-spawn cleanup failed', safeAcpProtocolDetails({ error: cleanupError })); }
      finally {
        this.spawnCleanup = null;
        releaseStartupGate?.();
        this.releaseConcurrencySlot();
      }
      throw error;
    }
    this.attachProcessListeners();

    try {
      const initializeParams: AcpInitializeParams = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: this.acpConfig.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES,
        clientInfo: this.acpConfig.clientInfo ?? DEFAULT_CLIENT_INFO,
      };
      const initializeResult = await this.sendRequest<AcpInitializeResult>('initialize', initializeParams)
        .finally(() => releaseStartupGate?.());
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

      await this.authenticateIfConfigured(initializeResult.authMethods);

      const sessionId = await this.openSession();
      this.setSessionId(sessionId);
      await this.applySessionConfig(sessionId);
      this.initialized = true;
      this.emit('status', 'ready');

      return this.getPid() ?? -1;
    } catch (error) {
      await this.terminate(false);
      throw error;
    }
  }

  private async authenticateIfConfigured(
    authMethods: AcpInitializeResult['authMethods'],
  ): Promise<void> {
    const methodId = this.acpConfig.authMethodId?.trim();
    if (!methodId) {
      return;
    }

    const advertised = authMethods?.some((method) => method['id'] === methodId) ?? false;
    if (!advertised) {
      throw new Error(
        `ACP agent did not advertise configured authentication method '${methodId}'.`,
      );
    }

    await this.sendRequest<unknown>('authenticate', { methodId });
  }

  protected override async sendInputImpl(message: string, attachments?: FileAttachment[], _metadata?: CliMessage['metadata'], dispatch?: AdapterInputDispatch): Promise<void> {
    const writePhase = { accepted: false, cancelledByClient: false };
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
      }, dispatch, writePhase);
    } catch (error) {
      // Surface provider/runtime failures as an `error` OutputMessage plus
      // `status: error` (matching the CopilotCliAdapter contract). Scheduling
      // collisions are handled separately below so the live turn stays owned
      // by the adapter and the renderer can park the follow-up message.
      const err = error instanceof Error ? error : new Error(String(error));
      if (!writePhase.accepted && writePhase.cancelledByClient && isAcpInputWriteFailure(err)) {
        this.clearStreamIdleWatchdog();
        throw Object.assign(new Error(ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE, { cause: err }), { name: 'AbortError' });
      }
      if (!writePhase.accepted) {
        try { assertAdapterInputCurrent(dispatch); }
        catch (cancelled) { this.clearStreamIdleWatchdog(); throw cancelled; }
      }
      if (err.name === 'AbortError' || isStdinWriteProcessError(err) || (isAcpInputWriteFailure(err) && (err as NodeJS.ErrnoException).code === 'EPIPE')) {
        this.clearStreamIdleWatchdog(); throw err;
      }
      if (!isAcpInputWriteFailure(err) && isAcpPromptCancelledByClient(err)) {
        this.clearStreamIdleWatchdog();
        this.emit('status', 'idle');
        return;
      }
      // The process already exited — its `exit` event owns the aftermath
      // (auto-respawn with resend, or the terminal crash error). Emitting
      // `status: 'error'`/`error` here races that handling exactly like the
      // EPIPE case guarded in instance-communication.ts, marking the instance
      // unrecoverable before auto-respawn's abort check runs (plan 2026-09-26).
      if (!isAcpInputWriteFailure(err) && isAcpAgentExitRejection(err)) {
        this.clearStreamIdleWatchdog();
        logger.info('ACP prompt rejected by agent exit — deferring to exit recovery', { adapter: this.getName(), ...safeAcpProtocolDetails({ error: err }) });
        if (!writePhase.accepted) throw err;
        return;
      }
      // This is a scheduling collision, not a provider/runtime failure. Let
      // the caller return it through IPC so the renderer can park the message
      // behind the authoritative active turn without poisoning the adapter.
      if (isAcpActiveTurnCollision(err)) {
        throw err;
      }
      const isRecoverablePromptTimeout = isAcpPromptRequestTimeout(err);
      const errorMessage: OutputMessage = {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: err.message,
        metadata: {
          source: 'acp-send-input',
          transport: 'acp',
          adapter: this.getName(),
          ...(isRecoverablePromptTimeout ? {
            recoverable: true,
            retryKind: 'acp-prompt-timeout',
          } : {}),
        },
      };
      this.emit('output', errorMessage);
      this.emit('status', isRecoverablePromptTimeout ? 'idle' : 'error');
      this.emit('error', err);
      // A post-write provider failure still owns its turn through events. A
      // rejected native write never delivered input and must fail its receipt.
      if (!writePhase.accepted || isAcpInputWriteFailure(err)) throw err;
    }
  }

  async sendMessage(message: CliMessage, dispatch?: AdapterInputDispatch, writePhase = { accepted: false, cancelledByClient: false }): Promise<CliResponse> {
    const admission = createAdapterInputDispatch(dispatch);
    assertAdapterInputCurrent(admission);
    if (message.role !== 'user') {
      throw new Error('ACP adapter only supports user-initiated prompt turns.');
    }

    if (!this.initialized || !this.process) {
      await this.spawn();
    }
    assertAdapterInputCurrent(admission);

    if (!this.sessionId) {
      throw new Error('ACP session has not been initialized.');
    }

    // Awaited before the busy guard so the guard and the turn setup below stay
    // synchronous with each other.
    if (this.acpConfig.persistImageAttachments && message.attachments?.length) {
      message = {
        ...message,
        attachments: await withPersistedAcpImageAttachments(this.sessionId, message.attachments),
      };
    }

    assertAdapterInputCurrent(admission);
    if (this.currentPrompt || this.currentPromptRequestId) {
      throw new Error(
        'Cannot send message: the previous turn is still running. ' +
        'Wait for it to finish, or cancel/interrupt the current turn first.',
      );
    }

    const queuedContext = this.nextPromptContext.slice();
    const previousPromptFlags = { system: this.systemPromptSent, rtk: this.rtkAwarenessSent };
    const promptParams: AcpSessionPromptParams = {
      sessionId: this.sessionId,
      prompt: [...queuedContext.map((text) => ({ type: 'text' as const, text })), ...this.toPromptBlocks(message)],
    };

    const responseId = this.generateResponseId();
    this.toolCalls.clear();
    this.delegatedLiveness.clear();
    this.outputBlockedNoticed = false;
    this.stallKindsNoticed.clear();
    // Hold the turn in a local. The process `'exit'` handler nulls
    // `this.currentPrompt` synchronously *before* it rejects the pending
    // request, and that rejection only resumes this await a microtask later —
    // so re-reading the field after the await loses a crashed turn's buffered
    // output and its partial-usage estimate entirely.
    const turn: AcpPendingPromptTurn = createAcpAssistantTurn(responseId);
    turn.writePhase = writePhase;
    this.currentPrompt = turn;

    try {
      this.emit('status', 'busy');
      assertAdapterInputCurrent(admission);
      this.armStallWatchdog();
      const result = await this.sendRequest<AcpSessionPromptResult>('session/prompt', promptParams, admission, writePhase);
      const duration = Date.now() - turn.startedAt;
      const responseText = turn.chunks.join('');
      const usage = toAcpCliUsage(
        result.usage,
        duration,
        message.content,
        responseText,
        turn.toolActivityChunks.join('\n'),
      );
      const turnCostUsd = this.costLedger.settleTurn();
      if (usage && turnCostUsd !== undefined) usage.cost = turnCostUsd;
      else if (usage && usage.cost === undefined && this.acpConfig.reportedCostOnly) usage.cost = 0;
      // LT-018: publish the raw ACP usage aggregate (not the LT-100 estimate
      // above) so occupancy stays honest ("no usage ⇒ no event") even when
      // cost falls back to an estimate.
      const providerUsageReported = this.publishContextUsageFromTurn(result.usage, duration);
      const { response, truncated, logFields } = buildAcpTurnCompletion({
        result, turn, usage, toolCalls: this.toolCalls.values(), adapter: this.getName(),
        model: this.acpConfig.model, providerUsageReported, generationBudget: this.acpConfig.generationBudget,
        leaseMs: turn.leaseMs ?? this.acpConfig.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
      });
      logger.info('ACP turn completed', logFields);

      this.resolveRetryNotice(turn);
      this.emitFinalAssistantFlushes(turn);
      this.flushUnsettledToolResults();
      if (truncated) {
        logger.warn(truncated.logMessage, truncated.logFields);
        this.emit('output', truncated.notice);
      }
      this.emit('status', 'idle');
      this.completeResponse(response);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.systemPromptSent = previousPromptFlags.system; this.rtkAwarenessSent = previousPromptFlags.rtk;
        this.emit('status', 'idle'); throw error;
      }
      const failure = tagAcpProviderLimit(toError(error, 'ACP prompt turn failed.'));
      if (!writePhase.accepted || isAcpInputWriteFailure(failure)) {
        this.systemPromptSent = previousPromptFlags.system;
        this.rtkAwarenessSent = previousPromptFlags.rtk;
      }
      Object.assign(failure, { turnEnding: classifyTurnEnding({ kind: 'error', error: failure, metadata: failure }) });
      this.emitFinalAssistantFlushes(turn);
      this.flushUnsettledToolResults();
      const partialText = turn.chunks.join('');
      const partialToolActivity = turn.toolActivityChunks.join('\n');
      // The prompt alone is not "partial material". `estimateAcpCliUsage()`
      // counts `message.content` as input, so a turn that died before the agent
      // said or did anything would still estimate a positive total purely from
      // the prompt we sent — and a transport failure that never reached the
      // provider would be charged for tokens nobody spent. Require observed
      // assistant text or tool activity first; only then is the prompt fair to
      // count as the input side of a real, partially-served turn.
      const partialUsage = partialText || partialToolActivity
        ? estimateAcpCliUsage(
            message.content,
            partialText,
            partialToolActivity,
            Date.now() - turn.startedAt,
          )
        : undefined;
      if (partialUsage?.totalTokens) {
        if (this.acpConfig.reportedCostOnly) partialUsage.cost = 0;
        Object.assign(failure, {
          partialUsage,
          ...(this.acpConfig.model ? { partialModel: this.acpConfig.model } : {}),
        });
        logger.info('ACP failed turn retained estimated partial usage', {
          adapter: this.getName(),
          totalTokens: partialUsage.totalTokens,
          durationMs: partialUsage.duration,
        });
      }
      throw failure;
    } finally {
      if (writePhase.accepted) this.nextPromptContext.splice(0, queuedContext.length);
      this.recentAssistantTurn = this.currentPrompt ?? this.recentAssistantTurn;
      const lastTool = [...this.toolCalls.values()].at(-1);
      this.recentReadToolCallId = lastTool?.kind === 'read' && lastTool.status === 'completed' ? lastTool.id : null;
      this.currentPrompt = null;
      this.currentPromptRequestId = null;
      this.toolCalls.clear();
      this.delegatedLiveness.clear();
      this.clearStallWatchdog();
    }
  }

  queueNextPromptContext(text: string): void {
    if (text.trim()) this.nextPromptContext.push(text);
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
    await this.cancelPendingElicitationRequests();
    this.rejectPendingRequests(new Error('ACP adapter terminated before the request completed.'));
    this.clearStallWatchdog();
    this.initialized = false;
    this.currentPrompt = null;
    this.recentAssistantTurn = null;
    this.currentPromptRequestId = null;
    this.systemPromptSent = false;
    this.rtkAwarenessSent = false;
    // Usage telemetry is per-session state like the flags above. Carrying it
    // into a re-spawned session would suppress the first missing-usage warning
    // of the new one, and would let a stale `hasReportedUsage` report a usage
    // *regression* against a session that never reported any.
    this.hasReportedUsage = false;
    this.loggedMissingUsageWarning = false;
    this.loggedMissingUsage = false;
    this.cumulativeTokens = 0;
    this.measuredOccupancy = false;
    this.toolCalls.clear();
    this.delegatedLiveness.clear();
    this.stdoutFramer.clear();
    try {
      await super.terminate(graceful);
    } finally {
      this.spawnCleanup?.();
      this.spawnCleanup = null;
    }
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
        ...safeAcpProtocolDetails({ error }),
      });
    }
    this.concurrencyRelease = null;
  }

  // ============ Stall Watchdog ============

  /** Start the stall watchdog for the current turn. No-op when `stallWarningMs`
   *  is 0 (opt-out) or no prompt is in flight. Timer mechanics live in
   *  AcpStallWatchdog; this owns what a stall *says*. */
  private armStallWatchdog(): void {
    this.clearStallWatchdog();
    const timeoutMs = this.acpConfig.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
    if (timeoutMs <= 0) return;

    this.stallWatchdog = new AcpStallWatchdog(timeoutMs, {
      isTurnActive: () => this.currentPromptRequestId !== null,
      turnStartedAt: () => this.currentPrompt?.startedAt ?? null,
      // Same observation the `session/prompt` timeout reports from, so a
      // warning and the failure that may follow it never disagree.
      classifyWait: () => this.classifyCurrentTurnWait(),
      report: (report) => this.reportStall(report),
    });
    this.stallWatchdog.arm();
  }

  private reportStall(report: AcpStallReport): void {
    const context = buildAcpStallContext(
      report,
      this.getName(),
      this.sessionId,
      this.currentPromptRequestId,
    );
    // Always logged and always emitted as an event — the diagnostic record of a
    // stall should be complete.
    logger.warn('ACP prompt turn appears stalled', context);
    this.emit('stall_warning', context);

    // The transcript gets one notice per wait kind per turn. `system` messages
    // are NOT covered by the output buffer's repeated-content suppression
    // (which is gated on `type === 'error'`, instance-communication.ts) nor by
    // the renderer's identical-message collapse, so without this latch a long
    // legitimate tool run would append a notice every interval and evict real
    // evidence from the 20-message window child-diagnostics reads. Matches the
    // app's own stuck-process watchdog, which latches per state.
    if (this.stallKindsNoticed.has(report.wait.kind)) return;
    this.stallKindsNoticed.add(report.wait.kind);
    this.emit('output', buildAcpStallOutputMessage(report, this.getName(), generateId()));
  }

  /** Provider updates re-arm silence; the notice latch remains scoped to the turn. */
  private resetStallWatchdog(): void {
    if (!this.currentPromptRequestId) return;
    this.armStallWatchdog();
  }

  /** Turn completion and termination clear the silence timer. */
  private clearStallWatchdog(): void {
    this.stallWatchdog?.clear();
    this.stallWatchdog = null;
  }

  override interrupt(): InterruptResult {
    this.clearStreamIdleWatchdog();
    if (!this.sessionId || !this.currentPromptRequestId) {
      return { status: 'no-active-turn', reason: 'No ACP prompt is in flight' };
    }

    const turnId = String(this.currentPromptRequestId);
    const completion: Promise<TurnInterruptCompletion> = this.cancelCurrentPrompt()
      .then(() => ({
        status: 'interrupted' as const,
        turnId,
      }))
      .catch((error) => ({
        status: 'rejected' as const,
        turnId,
        reason: error instanceof Error ? error.message : String(error),
      }));

    const result: InterruptResult = { status: 'accepted', turnId };
    Object.defineProperty(result, 'completion', {
      value: completion,
      enumerable: false,
    });
    return result;
  }

  async sendRaw(response: string, permissionKey?: string): Promise<void> {
    const pending = this.resolvePendingPermissionRequest(permissionKey);
    if (pending) {
      const outcome = this.selectPermissionOutcome(pending, response, permissionKey);
      await this.sendResponse(pending.rpcId, { outcome });
      this.pendingPermissionRequests.delete(pending.key);
      // Close the registry entry with the user's real decision; left open, it
      // reads as "blocked on approval" and is later recorded as a timeout denial.
      const chosen = outcome.outcome === 'selected' ? pending.options.find((o) => o.optionId === outcome.optionId) : undefined;
      this.acpConfig.permissionRegistry?.resolve?.(pending.key, chosen?.kind.startsWith('allow') === true, 'user');
      this.emit('status', 'busy');
      return;
    }

    const pendingElicitation = this.resolvePendingElicitationRequest(permissionKey);
    if (!pendingElicitation) {
      // Coded so the respond handler can tell the renderer the card is stale, not failed.
      throw Object.assign(new Error('No pending ACP permission or elicitation request is waiting for a response.'), {
        code: 'INPUT_REQUIRED_NOT_PENDING',
      });
    }

    await this.sendResponse(
      pendingElicitation.rpcId,
      buildAcpElicitationResponse(pendingElicitation.params, response),
    );
    this.pendingElicitationRequests.delete(pendingElicitation.key);
    this.emit('status', 'busy');
  }

  private attachProcessListeners(): void {
    if (!this.process) {
      return;
    }

    this.process.stdout?.setEncoding('utf8');
    this.process.stderr?.setEncoding('utf8');

    this.process.stdout?.on('data', (chunk: string) => {
      if (chunk.length > 0) this.refreshCurrentPromptTimeout();
      this.handleStdoutChunk(chunk);
    });

    this.process.stderr?.on('data', (chunk: string) => {
      this.stderrTail.push(chunk);
      if (!this.outputBlockedNoticed && /(?:ACP.*(?:write|flush).*?(?:EAGAIN|temporarily unavailable)|stdout.*(?:EAGAIN|backpressure))/i.test(chunk)) {
        this.outputBlockedNoticed = true;
        this.emitStructuredOutput('system', 'Provider output is blocked. The transport is waiting for its output pipe to drain.', { source: 'acp-output-blocked', watchdogWarning: true });
      }
      logger.debug('ACP stderr', acpTextDiagnostic(chunk));
    });

    this.process.on('error', (error) => {
      logger.info('ACP process error', { adapter: this.getName(), ...safeAcpProtocolDetails({ error }), ...acpTextDiagnostic(this.stderrTail.dump() ?? '') });
      this.rejectPendingRequests(toError(error, 'ACP transport error'));
      this.emit('error', toError(error, 'ACP transport error'));
    });

    this.process.on('exit', (code, signal) => {
      logger.info('ACP process exited', { adapter: this.getName(), code, signal, ...acpTextDiagnostic(this.stderrTail.dump() ?? '') });
      this.stdoutFramer.clear();
      this.initialized = false;
      this.currentPromptRequestId = null;
      this.currentPrompt = null;
      this.delegatedLiveness.clear();
      this.recentAssistantTurn = null;
      this.rejectPendingRequests(new Error(`ACP agent exited (${code ?? 'null'}${signal ? `/${signal}` : ''}).`));
      for (const key of this.pendingPermissionRequests.keys()) this.withdrawInputRequired(key, 'exited');
      this.pendingPermissionRequests.clear();
      for (const key of this.pendingElicitationRequests.keys()) this.emitInputRequiredResolved(key, 'exited');
      this.pendingElicitationRequests.clear();
      this.clearStallWatchdog();
      // Free the concurrency slot so queued spawns can proceed even when the
      // agent dies without us calling terminate() (crash, EXC_BAD_ACCESS,
      // parent SIGKILL, etc.).
      this.releaseConcurrencySlot();
      this.emit('exit', code, signal);
    });
    const cleanup = this.spawnCleanup;
    this.process.once('close', () => {
      cleanup?.();
      if (this.spawnCleanup === cleanup) this.spawnCleanup = null;
    });
  }

  /** session/new + session/load servers, HTTP/SSE gated on `mcpCapabilities`. */
  private sessionMcpServers(): AcpMcpServerConfig[] {
    const { servers, dropped } = filterSessionMcpServers(this.acpConfig.mcpServers ?? [], this.agentCapabilities);
    if (dropped.length > 0) {
      logger.warn('ACP agent lacks mcpCapabilities for remote MCP servers — skipping them', { adapter: this.getName(), dropped });
    }
    return servers;
  }

  private async openSession(): Promise<string> {
    if (this.acpConfig.resume) {
      if (!this.acpConfig.sessionId) {
        this.lastResumeAttemptResult = {
          source: 'native',
          confirmed: false,
          reason: 'ACP resume requires a sessionId.',
        };
        throw new Error('ACP resume requires a sessionId.');
      }
      if (!this.agentCapabilities?.loadSession) {
        this.lastResumeAttemptResult = {
          source: 'native',
          confirmed: false,
          requestedSessionId: this.acpConfig.sessionId,
          requestedCursor: this.buildResumeCursor(this.acpConfig.sessionId),
          reason: 'ACP agent does not advertise loadSession support.',
        };
        throw new Error('ACP agent does not advertise loadSession support.');
      }
      const loadParams: AcpSessionLoadParams = {
        sessionId: this.acpConfig.sessionId,
        cwd: this.acpConfig.workingDirectory,
        mcpServers: this.sessionMcpServers(),
      };
      try {
        await this.sendRequest<{ configOptions?: unknown } | null>('session/load', loadParams);
        this.costLedger.reset(false);
      } catch (error) {
        this.lastResumeAttemptResult = {
          source: 'native',
          confirmed: false,
          requestedSessionId: this.acpConfig.sessionId,
          requestedCursor: this.buildResumeCursor(this.acpConfig.sessionId),
          reason: error instanceof Error ? error.message : String(error),
        };
        throw error;
      }
      this.lastResumeAttemptResult = {
        source: 'native',
        confirmed: true,
        requestedSessionId: this.acpConfig.sessionId,
        actualSessionId: this.acpConfig.sessionId,
        requestedCursor: this.buildResumeCursor(this.acpConfig.sessionId),
        actualCursor: this.buildResumeCursor(this.acpConfig.sessionId),
      };
      return this.acpConfig.sessionId;
    }

    const newParams: AcpSessionNewParams = {
      cwd: this.acpConfig.workingDirectory,
      mcpServers: this.sessionMcpServers(),
    };
    const result = await this.sendRequest<AcpSessionNewResult>('session/new', newParams);
    this.costLedger.reset(true);
    this.lastResumeAttemptResult = undefined;
    this.reportResolvedModel(result.models?.currentModelId);
    return result.sessionId;
  }

  /** Apply startup settings; routed accounts must confirm their native model selection. */
  private async applySessionConfig(sessionId: string): Promise<void> {
    const requested = this.acpConfig.sessionConfig;
    if (!requested?.model && !requested?.effort) {
      assertAcpGenerationBudgetSelection(this.acpConfig.generationBudget, requested, this.sessionConfigOptions);
      if (this.acpConfig.requireSessionModelConfirmation) {
        throw new Error('Unable to confirm the selected model for the routed account; refusing startup.');
      }
      return;
    }
    const modelWasSelected = requested.model ? isAcpSessionConfigSelected(this.sessionConfigOptions, 'model', requested.model) : false;
    const outcome = await applyAcpSessionConfig(
      (configId, value) => this.sendRequest('session/set_config_option', { sessionId, configId, value }),
      this.sessionConfigOptions,
      requested,
      () => this.sessionConfigOptions,
    );
    assertAcpGenerationBudgetSelection(this.acpConfig.generationBudget, requested, this.sessionConfigOptions, outcome);
    if (this.acpConfig.requireSessionModelConfirmation
      && (!(modelWasSelected || outcome.applied.some((entry) => entry.key === 'model' && entry.value === requested.model?.trim()))
        || !isAcpSessionModelConfirmed(requested.model, this.sessionConfigOptions, outcome))) {
      throw new Error('Unable to confirm the selected model for the routed account; refusing startup.');
    }
    if (outcome.warnings.length === 0) return;
    logger.warn('ACP session config not fully applied', { adapter: this.getName(), warningCount: outcome.warnings.length });
    this.emitStructuredOutput('system', `${outcome.warnings.join(' ')} The agent's own default is used instead.`, {
      source: 'acp-session-config',
    });
  }

  /**
   * Apply new session settings to the OPEN session without a restart — the
   * MiMo multi-account live switch (plan 2026-10-10 phase 4, probe 0.2).
   *
   * An in-flight turn is cancelled first: a turn stuck retrying a 429 keeps
   * retrying the OLD account after the model is switched (probe 0.2b), and the
   * cancelled prompt settles locally as a client-cancelled error, never as a
   * completed turn. The model and explicitly requested effort must be confirmed
   * here, so the caller cannot report an unapplied handoff. Startup effort
   * remains best effort; routed-account startup requires model confirmation.
   */
  async applyLiveSessionConfig(request: AcpSessionConfigRequest): Promise<void> {
    if (!this.process || !this.initialized || !this.sessionId) {
      throw new Error('ACP session is not running.');
    }
    if (this.currentPromptRequestId) {
      await this.cancelCurrentPrompt();
    }
    const outcome = await applyAcpSessionConfig(
      (configId, value) => this.sendRequest('session/set_config_option', { sessionId: this.sessionId!, configId, value }),
      this.sessionConfigOptions,
      request,
      () => this.sessionConfigOptions,
    );
    this.acpConfig.sessionConfig = confirmAcpLiveSessionConfig(
      this.acpConfig.sessionConfig, request, this.sessionConfigOptions, outcome,
    );
    if (outcome.warnings.length > 0) {
      logger.warn('ACP live session config not fully applied', {
        adapter: this.getName(),
        warningCount: outcome.warnings.length,
      });
    }
  }

  /**
   * Surface the model the agent actually bound to the session (from
   * `session/new`), so the UI can reconcile a chip that doesn't know the
   * concrete model (e.g. the `auto` sentinel). Emitted as a `'model'` event;
   * consumers decide whether/how to apply it. No-op when the agent reports
   * nothing parseable.
   */
  private reportResolvedModel(rawModelId: string | undefined): void {
    const normalized = normalizeAcpModelId(rawModelId);
    if (!normalized) return;
    this.emit('model', normalized);
  }

  private buildResumeCursor(sessionId: string): Record<string, unknown> {
    return {
      transport: 'acp',
      provider: this.getName(),
      sessionId,
      workspacePath: this.acpConfig.workingDirectory,
    };
  }

  private async cancelCurrentPrompt(): Promise<void> {
    if (!this.sessionId || !this.currentPromptRequestId) {
      return;
    }

    const cancelledRequestId = this.currentPromptRequestId;
    // Retain client intent on this write's owner before the cancel packet queues behind it.
    if (this.currentPrompt?.writePhase) this.currentPrompt.writePhase.cancelledByClient = true;

    // Notify the agent so it can tear down cleanly if it's still alive.
    // Best-effort: if stdin is already closed, we still want to reject the
    // local promise below so the caller unblocks.
    try {
      await this.sendNotification('session/cancel', { sessionId: this.sessionId });
    } catch (error) {
      logger.debug('ACP session/cancel notification failed; continuing with local cleanup', {
        adapter: this.getName(),
        ...safeAcpProtocolDetails({ error }),
      });
    }

    await this.cancelPendingPermissionRequests();
    await this.cancelPendingElicitationRequests();

    // Locally reject the in-flight session/prompt promise and purge it from
    // pendingRequests. Previously cancel was a fire-and-forget notification —
    // if the agent ignored it, `sendMessage` stayed pending forever.
    const pending = this.pendingRequests.get(cancelledRequestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(cancelledRequestId);
      pending.reject(new Error(ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE));
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
          logger.debug('Failed to cancel ACP permission request during cleanup', safeAcpProtocolDetails({ key: request.key, error }));
        }
      }),
    );
    // Live keys, not the pre-await snapshot: an exit during the await already withdrew them.
    const stillOpen = [...this.pendingPermissionRequests.keys()];
    this.pendingPermissionRequests.clear();
    for (const key of stillOpen) this.withdrawInputRequired(key, 'cancelled');
  }

  private async cancelPendingElicitationRequests(): Promise<void> {
    const pending = [...this.pendingElicitationRequests.values()];
    await Promise.all(
      pending.map(async (request) => {
        try {
          await this.sendResponse(request.rpcId, { action: 'cancel' });
        } catch (error) {
          logger.debug('Failed to cancel ACP elicitation request during cleanup', safeAcpProtocolDetails({ key: request.key, error }));
        }
      }),
    );
    const stillOpen = [...this.pendingElicitationRequests.keys()];
    this.pendingElicitationRequests.clear();
    for (const key of stillOpen) this.emitInputRequiredResolved(key, 'cancelled');
  }

  private rejectPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutFramer.push(chunk, (rawLine) => {
      try {
        this.handleMessageLine(rawLine);
      } catch (error) {
        this.emitRecoverableProtocolError('ACP message handler failed', { error, line: rawLine });
      }
    }, (limitChars) => this.emitRecoverableProtocolError('Oversized ACP JSON-RPC record discarded', { limitChars }));
  }

  private handleMessageLine(rawLine: string): void {
    let parsed: AcpJsonRpcMessage;

    try {
      parsed = JSON.parse(rawLine) as AcpJsonRpcMessage;
    } catch (error) {
      this.emitRecoverableProtocolError('Failed to parse ACP JSON-RPC line', {
        error,
        line: rawLine,
      });
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
      void this.handleInboundRequest(parsed).catch((error) => {
        this.emitRecoverableProtocolError('ACP request handler failed', {
          id: parsed.id,
          method: parsed.method,
          error,
        });
        void this.sendErrorResponse(parsed.id, JSON_RPC_INVALID_REQUEST, 'Failed to handle ACP request.')
          .catch((error) => this.emitRecoverableProtocolError('ACP error response write failed', { error }));
      });
      return;
    }

    if (isAcpJsonRpcNotification(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    void this.sendErrorResponse(null, JSON_RPC_INVALID_REQUEST, 'Invalid ACP JSON-RPC message.')
      .catch((error) => this.emitRecoverableProtocolError('ACP error response write failed', { error }));
  }

  private handleSuccessResponse(response: AcpJsonRpcSuccessResponse): void {
    const key = String(response.id);
    const pending = this.pendingRequests.get(key);
    if (!pending) {
      logger.debug('Ignoring ACP success response for unknown id', safeAcpProtocolDetails({ id: key }));
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(key);
    try {
      const state = reduceAcpSessionConfigResponse(this.sessionConfigOptions, pending, response.result);
      if (state.sessionId !== undefined) this.setSessionId(state.sessionId);
      this.sessionConfigOptions = state.configOptions;
    } catch (error) {
      pending.reject(toError(error, 'Invalid ACP session response.'));
      return;
    }
    pending.resolve(response.result);
  }

  private handleErrorResponse(response: AcpJsonRpcErrorResponse): void {
    settleAcpErrorResponse(response, this.pendingRequests, (error) => this.emit('error', error));
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
      case '_x.ai/session_notification':
        // Grok wraps lifecycle updates in a vendor notification whose params
        // match `session/update`; route them through the shared handler.
        this.handleSessionUpdate(notification.params as AcpSessionUpdateNotificationParams);
        return;
      case 'elicitation/complete':
        this.handleElicitationComplete(notification.params as AcpElicitationCompleteParams);
        return;
      default:
        logger.debug('Ignoring ACP notification', safeAcpProtocolDetails({ method: notification.method }));
    }
  }

  private handleSessionUpdate(params: AcpSessionUpdateNotificationParams): void {
    if (!isRecord(params)) {
      this.emitRecoverableProtocolError('Malformed ACP session/update params', {
        expected: 'object',
      });
      return;
    }

    const sessionId = optionalString(params['sessionId']);
    if (!this.sessionId || sessionId !== this.sessionId) {
      return;
    }

    // Any inbound session/update resets the stall watchdog — the agent is
    // clearly still alive even if individual updates take a while. We do
    // this up front so the reset applies even to updates we don't have a
    // specific handler branch for below. Heartbeat keeps Loop Mode's
    // iteration timeout from treating metadata-only updates as silence.
    this.refreshCurrentPromptTimeout();
    this.resetStallWatchdog();
    this.emit('heartbeat');

    const rawUpdate = params['update'];
    if (!isRecord(rawUpdate)) {
      this.emitRecoverableProtocolError('Malformed ACP session update payload', {
        sessionId,
        expected: 'object',
      });
      return;
    }

    const sessionUpdate = optionalString(rawUpdate['sessionUpdate']);
    if (!sessionUpdate) {
      this.emitRecoverableProtocolError('Malformed ACP session update payload', {
        sessionId,
        missing: 'sessionUpdate',
      });
      return;
    }

    const update = rawUpdate as unknown as AcpSessionUpdate;
    switch (sessionUpdate) {
      case 'agent_message_chunk':
      case 'user_message_chunk':
        this.handleMessageChunk(update as Extract<AcpSessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'user_message_chunk' }>);
        break;
      case 'tool_call':
        this.handleToolCallCreated(update as Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>);
        break;
      case 'tool_call_update':
        this.handleToolCallDelta(update as AcpToolCallDeltaUpdate);
        break;
      case 'plan':
        {
          const entries = this.normalizePlanEntries(rawUpdate);
          this.emitStructuredOutput('system', renderAcpPlan(entries), {
            sessionUpdate,
            entries,
          });
        }
        break;
      case 'available_commands_update':
        {
          // Slash-command discovery (cursor-agent advertises ~25; copilot
          // varies). This is metadata about what the agent knows how to do,
          // not conversation content — surfacing it as a chat bubble was
          // pure noise. Parse it for diagnostics; if the agent ever exposes
          // a command palette in the UI, this is the hook to wire up.
          const commands = normalizeAcpAvailableCommands(rawUpdate);
          logger.debug('ACP available_commands_update', { ...safeAcpProtocolDetails({ sessionId }), commandCount: commands.length });
        }
        break;
      case 'retry_state':
        this.handleRetryState(update as Extract<AcpSessionUpdate, { sessionUpdate: 'retry_state' }>);
        break;
      case 'agent_thought_chunk': {
        // Reasoning, never answer text. Replayed history (no live turn) is dropped.
        const turn = this.currentPrompt ?? this.recentAssistantTurn;
        const text = this.extractContentText(rawUpdate['content'] as AcpContentBlock | undefined);
        if (turn) appendAcpThoughtDelta(turn, optionalString(rawUpdate['messageId']), text);
        break;
      }
      case 'usage_update':
        this.handleUsageUpdate(rawUpdate);
        break;
      case 'config_option_update':
        if (Array.isArray(rawUpdate['configOptions'])) this.sessionConfigOptions = rawUpdate['configOptions'];
        break;
      case 'session_info_update':
        // Session metadata (auto-generated title, summary, mode/model
        // defaults). Older code dumped raw JSON into the chat — e.g.
        // `{"sessionUpdate":"session_info_update","title":"Orchestrator
        // Optimizer"}` showed up as a system bubble while the user was
        // trying to follow a real conversation. Suppress; future work can
        // route `title`/`summary` to a dedicated event so the UI can
        // rename the instance tab.
        logger.debug('ACP session metadata update', safeAcpProtocolDetails({ sessionId, sessionUpdate }));
        break;
      default:
        logger.debug('Ignoring ACP session update variant', safeAcpProtocolDetails({ sessionUpdate }));
    }
    this.refreshCurrentPromptTimeout();
  }

  private handleMessageChunk(update: Extract<AcpSessionUpdate, { sessionUpdate: 'agent_message_chunk' | 'user_message_chunk' }>): void {
    if (update.sessionUpdate === 'user_message_chunk' && this.currentPrompt) {
      // In-flight user chunks are Grok prompt echoes. Suppress duplicates and
      // injected sentinels; replayed history outside a turn still flows.
      return;
    }
    const rawContent = this.extractContentText(update.content);
    const content = update.sessionUpdate === 'agent_message_chunk'
      ? normalizeAcpAssistantDelta(rawContent)
      : rawContent;
    if (!content) {
      return;
    }

    const messageType = update.sessionUpdate === 'agent_message_chunk' ? 'assistant' : 'user';
    const turn = resolveAcpChunkTurn(
      this.currentPrompt,
      this.recentAssistantTurn,
      update.sessionUpdate,
    );
    const rawMessageId = update.messageId;
    const messageId = update.sessionUpdate === 'agent_message_chunk'
      ? (turn?.responseId ?? rawMessageId ?? generateId())
      : (rawMessageId ?? turn?.responseId ?? generateId());
    let accumulatedContent = content;
    if (turn && update.sessionUpdate === 'agent_message_chunk') {
      accumulatedContent = appendAcpAssistantDelta(turn, messageId, content);
    }

    if (!this.currentPrompt && turn && update.sessionUpdate === 'agent_message_chunk') {
      this.emitFinalAssistantFlushes(turn);
      return;
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
        ...(rawMessageId && rawMessageId !== messageId ? { acpMessageId: rawMessageId } : {}),
      },
    } satisfies OutputMessage);
  }

  private handleRetryState(update: Extract<AcpSessionUpdate, { sessionUpdate: 'retry_state' }>): void {
    const turn = this.currentPrompt;
    const messageId = turn ? (turn.retryNoticeId ??= generateId()) : generateId();
    this.emit('output', buildRetryStateMessage(update, messageId));
  }
  private handleUsageUpdate(rawUpdate: Record<string, unknown>): void {
    const update = parseAcpUsageUpdate(rawUpdate);
    this.costLedger.observe(update.sessionCostUsd, this.currentPrompt !== null);
    const event = buildAcpMeasuredContextEvent(update, this.cumulativeTokens);
    if (!event) return;
    this.measuredOccupancy = true;
    this.emit('context', event);
  }
  private resolveRetryNotice(turn: AcpPendingPromptTurn): void {
    if (turn.retryNoticeId) this.emit('output', buildRetryRecoveredMessage(turn.retryNoticeId));
  }
  private emitFinalAssistantFlushes(turn: AcpPendingPromptTurn): void {
    const thinking = buildAcpTurnThinking(turn);
    const flushes = collectAcpAssistantFlushes(turn);
    // A turn that only reasoned (no answer text) still shows its thinking.
    if (flushes.length === 0 && thinking) flushes.push({ id: turn.responseId, content: '' });
    for (const flush of flushes) {
      this.emit('output', {
        id: flush.id,
        timestamp: Date.now(),
        type: 'assistant',
        content: flush.content,
        metadata: {
          transport: 'acp',
          streaming: false,
          accumulatedContent: flush.content,
        },
        ...(thinking ? { thinking, thinkingExtracted: true } : {}),
      } satisfies OutputMessage);
    }
  }

  private handleToolCallCreated(update: Extract<AcpSessionUpdate, { sessionUpdate: 'tool_call' }>): void {
    const toolCallId = optionalString((update as unknown as Record<string, unknown>)['toolCallId']) ?? generateId();
    const title = optionalString((update as unknown as Record<string, unknown>)['title']) ?? toolCallId;
    const kind = (optionalString((update as unknown as Record<string, unknown>)['kind']) as AcpToolKind | undefined) ?? 'other';
    const status = (optionalString((update as unknown as Record<string, unknown>)['status']) as AcpToolCallStatus | undefined) ?? 'pending';
    if (toolCallId !== update.toolCallId || title !== update.title) {
      this.emitRecoverableProtocolError('Malformed ACP tool_call update', {
        sessionUpdate: 'tool_call',
        missing: !update.toolCallId ? 'toolCallId' : 'title',
      });
    }

    const observed: AcpObservedToolCall = {
      id: toolCallId,
      title,
      kind,
      status,
      rawInput: update.rawInput,
      delegatedTask: isDelegatedAcpTask({ kind, title, rawInput: update.rawInput }),
    };
    this.toolCalls.set(toolCallId, observed);
    this.delegatedLiveness.observe(toolCallId, observed, this.sessionId);
    // LT-100 estimate material only (see estimateAcpCliUsage()); never sent anywhere.
    this.currentPrompt?.toolActivityChunks.push(
      `${title} ${update.rawInput ? JSON.stringify(update.rawInput) : ''}`,
    );

    const toolCall: CliToolCall = {
      id: toolCallId,
      name: title,
      arguments: buildAcpToolCallArguments(observed.kind, update.rawInput),
    };
    this.emit('tool_use', toolCall);
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: title,
      metadata: {
        toolCallId,
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
        ...buildAcpMinableInput(update.rawInput),
      },
    } satisfies OutputMessage);
  }

  private handleToolCallDelta(update: AcpToolCallDeltaUpdate): void {
    const toolCallId = optionalString((update as unknown as Record<string, unknown>)['toolCallId']) ?? generateId();
    const observed = this.toolCalls.get(toolCallId);
    const title = optionalString((update as unknown as Record<string, unknown>)['title']) ?? observed?.title ?? toolCallId;
    const kind = (optionalString((update as unknown as Record<string, unknown>)['kind']) as AcpToolKind | undefined) ?? observed?.kind ?? 'other';
    const status = (optionalString((update as unknown as Record<string, unknown>)['status']) as AcpToolCallStatus | undefined) ?? observed?.status ?? 'pending';
    if (toolCallId !== update.toolCallId) {
      this.emitRecoverableProtocolError('Malformed ACP tool_call_update update', {
        sessionUpdate: 'tool_call_update',
        missing: 'toolCallId',
      });
    }

    // Cursor never populates `content`; its results arrive in `rawOutput` only (see acp-tool-call-material.ts).
    const renderedOutput = this.extractToolOutputText(update.content) || renderAcpRawOutput(update.rawOutput);
    // LT-100 estimate material too (see handleToolCallCreated above). A newer
    // snapshot replaces the call's earlier one, or the estimate would count the
    // same output once per update.
    let outputChunkIndex = observed?.outputChunkIndex;
    const chunks = this.currentPrompt?.toolActivityChunks;
    if (renderedOutput && chunks) {
      if (outputChunkIndex !== undefined && outputChunkIndex < chunks.length) chunks[outputChunkIndex] = renderedOutput;
      else outputChunkIndex = chunks.push(renderedOutput) - 1;
    }
    // Each update carries a whole snapshot, so only the latest is kept and it is
    // emitted once (see buildAcpToolResultMessage). A settling update without
    // content keeps the last snapshot seen.
    const output = renderedOutput || observed?.pendingOutput || '';
    const terminal = isAcpTerminalToolStatus(status);
    const rawInput = update.rawInput ?? observed?.rawInput;
    this.toolCalls.set(toolCallId, {
      id: toolCallId,
      title,
      kind,
      status,
      rawInput,
      delegatedTask: !isBackgroundAcpTask(rawInput) && (observed?.delegatedTask === true || isDelegatedAcpTask({ kind, title, rawInput })),
      ...(!terminal && output ? { pendingOutput: output } : {}),
      ...(outputChunkIndex !== undefined ? { outputChunkIndex } : {}),
    });
    this.delegatedLiveness.observe(toolCallId, { status, kind, title, rawInput }, this.sessionId);
    if (!terminal) return;

    if (output) {
      this.emit('output', buildAcpToolResultMessage(
        { toolCallId, title, status, sessionUpdate: update.sessionUpdate, output, rawOutput: update.rawOutput },
        generateId(), Date.now(),
      ));
    }
    const toolCall: CliToolCall = {
      id: toolCallId,
      name: title,
      arguments: buildAcpToolCallArguments(kind, update.rawInput ?? observed?.rawInput),
      // No `result` key when nothing was captured: downstream hashing fails open on absent, not on ''.
      ...(output ? { result: output } : {}),
    };
    this.emit('tool_result', toolCall);
    // LT-196: covers a terminal call that rendered no output (see helper).
    const fallback = buildAcpToolOutcomeFallback(
      { toolCallId, status, title, hasRenderedOutput: Boolean(output), rawOutput: update.rawOutput },
      generateId(), Date.now(),
    );
    if (fallback) this.emit('output', fallback);
  }

  /**
   * Surface the last output of calls the turn ended before they settled. Runs
   * as the turn ends, before idle or the failure is reported; not on
   * `terminate()`, whose callers detach listeners first.
   */
  private flushUnsettledToolResults(): void {
    for (const call of this.toolCalls.values()) {
      const output = call.pendingOutput;
      if (!output) continue;
      call.pendingOutput = undefined;
      this.emit('output', buildAcpToolResultMessage(
        { toolCallId: call.id, title: call.title, status: call.status, sessionUpdate: 'tool_call_update', output },
        generateId(), Date.now(),
      ));
    }
  }

  private async handlePermissionRequest(
    request: AcpJsonRpcRequest<AcpSessionRequestPermissionParams>,
  ): Promise<void> {
    const params = request.params;
    if (!isRecord(params)) {
      await this.sendErrorResponse(request.id, JSON_RPC_INVALID_REQUEST, 'Missing params for session/request_permission.');
      return;
    }

    const toolCall = params['toolCall'];
    if (!isRecord(toolCall)) {
      await this.sendErrorResponse(request.id, JSON_RPC_INVALID_REQUEST, 'Missing toolCall for session/request_permission.');
      return;
    }

    const toolCallId = optionalString(toolCall['toolCallId']);
    if (!toolCallId) {
      await this.sendErrorResponse(request.id, JSON_RPC_INVALID_REQUEST, 'Missing toolCall.toolCallId for session/request_permission.');
      return;
    }

    const options = this.normalizePermissionOptions(params['options']);
    const key = this.buildPermissionKey(request.id);
    const pending: AcpPendingPermissionRequest = {
      key,
      rpcId: request.id,
      sessionId: optionalString(params['sessionId']) ?? this.sessionId ?? '',
      toolCallId,
      title: optionalString(toolCall['title']) ?? toolCallId,
      kind: (optionalString(toolCall['kind']) as AcpToolKind | undefined) ?? 'other',
      options,
      createdAt: Date.now(),
    };
    this.pendingPermissionRequests.set(key, pending);

    const automatic = resolveAcpAutomaticPermission(this.getName(), this.acpConfig.permissionContext?.yoloMode, toolCall);
    if (automatic !== undefined) {
      if (!automatic) this.emitStructuredOutput('system', DOOM_LOOP_BLOCKED_NOTICE, { doomLoopBlocked: true, transport: 'acp' });
      await this.resolvePermissionDecision(key, {
        requestId: key,
        granted: automatic,
        decidedBy: 'auto_approve',
        decidedAt: Date.now(),
      }, { cardShown: false });
      return;
    }

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
        options: pending.options,
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
          logger.warn('ACP permission registry resolution failed', safeAcpProtocolDetails({ key: pending.key, error }));
        });
    }
  }

  private handleElicitationRequest(request: AcpJsonRpcRequest<AcpElicitationCreateParams>): void {
    const params = request.params;
    const key = this.buildElicitationKey(request.id);
    this.pendingElicitationRequests.set(key, {
      key,
      rpcId: request.id,
      params,
    });
    const prompt = [
      params?.message,
      params?.title,
      params?.description,
      params?.url ? `Open in browser: ${params.url}` : undefined,
      params?.requestedSchema || params?.schema
        ? `Schema: ${JSON.stringify(params.requestedSchema ?? params.schema)}`
        : undefined,
    ].filter(Boolean).join('\n\n');

    this.emit('input_required', {
      id: key,
      prompt: prompt || 'ACP elicitation request received.',
      timestamp: Date.now(),
      metadata: {
        type: 'acp_elicitation',
        transport: 'acp',
        mode: params?.mode,
        schema: params?.requestedSchema ?? params?.schema,
        url: params?.url,
        elicitationId: params?.elicitationId,
      },
    });
  }

  private handleElicitationComplete(params: AcpElicitationCompleteParams): void {
    if (!isRecord(params)) {
      this.emitRecoverableProtocolError('Malformed ACP elicitation/complete params', {
        expected: 'object',
      });
      return;
    }

    const elicitationId = optionalString(params['elicitationId']) ?? 'unknown';
    this.emitStructuredOutput('system', `ACP elicitation completed: ${elicitationId}`, {
      transport: 'acp',
      elicitationId,
      type: 'acp_elicitation_complete',
    });
  }

  private async resolvePermissionDecision(
    key: string,
    decision: PermissionDecision,
    { cardShown = true }: { cardShown?: boolean } = {},
  ): Promise<void> {
    const pending = this.pendingPermissionRequests.get(key);
    if (!pending) {
      return;
    }

    const responseText = decision.granted ? 'allow' : 'deny';
    const outcome = this.selectPermissionOutcome(pending, responseText, key);
    await this.sendResponse(pending.rpcId, { outcome });
    // Settled without the user (timeout, auto-approve, parent decision): the
    // renderer card for this request must go, or it stays up answering nothing.
    // Only if still ours: an exit during the await has already withdrawn it.
    if (this.pendingPermissionRequests.delete(key) && cardShown) {
      this.emitInputRequiredResolved(key, decision.decidedBy === 'timeout' ? 'timeout'
        : decision.decidedBy === 'auto_approve' ? 'auto_approved' : 'decided');
    }
    this.emit('status', 'busy');
  }

  private emitInputRequiredResolved(id: string, reason: InputRequiredResolvedReason): void {
    this.emit('input_required_resolved', { id, reason });
  }

  /** A permission request nobody answered: close its registry entry (banner, audit) and its card. */
  private withdrawInputRequired(key: string, reason: Extract<InputRequiredResolvedReason, 'cancelled' | 'exited'>): void {
    this.acpConfig.permissionRegistry?.resolve?.(key, false, 'cancelled');
    this.emitInputRequiredResolved(key, reason);
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

  private emitRecoverableProtocolError(reason: string, details: Record<string, unknown> = {}): void {
    const safeDetails = safeAcpProtocolDetails(details);
    logger.warn(reason, safeDetails);

    this.protocolErrorOutputCount += 1;
    if (this.protocolErrorOutputCount > 3) {
      if (this.protocolErrorOutputCount === 4) {
        this.emitStructuredOutput('error', 'Additional malformed ACP protocol messages are being suppressed.', {
          transport: 'acp',
          source: 'acp-protocol-error',
          recoverable: true,
          suppressed: true,
        });
      }
      return;
    }

    this.emitStructuredOutput('error', `${reason}. The malformed ACP message was ignored and the session remains active.`, {
      ...safeDetails,
      transport: 'acp',
      source: 'acp-protocol-error',
      recoverable: true,
    });
  }

  private extractContentText(content: AcpContentBlock | undefined): string {
    if (!isRecord(content)) {
      return '';
    }

    const type = content['type'];
    if (type === 'text') {
      return optionalString(content['text']) ?? '';
    }

    if (type === 'image') {
      const uri = optionalString(content['uri']);
      return uri ? `[Image attachment: ${uri}]` : '[Image attachment]';
    }

    const resource = content['resource'];
    if (isRecord(resource)) {
      return optionalString(resource['text'])
        ?? optionalString(resource['title'])
        ?? optionalString(resource['uri'])
        ?? '';
    }

    return '';
  }

  private extractToolOutputText(items?: AcpToolCallOutputItem[]): string {
    if (!Array.isArray(items) || items.length === 0) {
      return '';
    }

    return items
      .map((item) => isRecord(item) ? this.extractContentText(item['content'] as AcpContentBlock | undefined) : '')
      .filter(Boolean)
      .join('\n');
  }

  private normalizePlanEntries(update: Record<string, unknown>): AcpPlanUpdate['entries'] {
    const entries = update['entries'];
    if (!Array.isArray(entries)) {
      this.emitRecoverableProtocolError('Malformed ACP plan update', {
        sessionUpdate: 'plan',
        field: 'entries',
        expected: 'array',
      });
      return [];
    }

    return entries.flatMap((entry) => {
      if (!isRecord(entry)) {
        return [];
      }

      const content = optionalString(entry['content']);
      if (!content) {
        return [];
      }

      return [{
        content,
        priority: optionalString(entry['priority']),
        status: optionalString(entry['status']),
      }];
    });
  }

  private normalizePermissionOptions(options: unknown): AcpPermissionOption[] {
    if (!Array.isArray(options)) {
      this.emitRecoverableProtocolError('Malformed ACP permission request options', {
        method: 'session/request_permission',
        field: 'options',
        expected: 'array',
      });
      return [];
    }

    return options.flatMap((option) => {
      if (!isRecord(option)) {
        return [];
      }

      const optionId = optionalString(option['optionId']);
      const name = optionalString(option['name']);
      const kind = optionalString(option['kind']);
      if (!optionId || !name || !kind) {
        return [];
      }

      return [{
        optionId,
        name,
        kind: kind as AcpPermissionOption['kind'],
      }];
    });
  }

  private buildPermissionPrompt(pending: AcpPendingPermissionRequest): string {
    const lines = pending.options.length > 0
      ? pending.options.map((option) => `- ${option.name}`)
      : ['- No explicit options advertised.'];
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

  private buildElicitationKey(id: AcpJsonRpcId | string): string {
    return `acp_elicitation:${String(id)}`;
  }

  private resolvePendingElicitationRequest(permissionKey?: string): AcpPendingElicitationRequest | undefined {
    if (permissionKey) {
      if (this.pendingElicitationRequests.has(permissionKey)) {
        return this.pendingElicitationRequests.get(permissionKey);
      }

      const derived = this.buildElicitationKey(permissionKey);
      if (this.pendingElicitationRequests.has(derived)) {
        return this.pendingElicitationRequests.get(derived);
      }
    }

    if (this.pendingElicitationRequests.size === 1) {
      return this.pendingElicitationRequests.values().next().value;
    }

    return undefined;
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

    if (!this.acpConfig.resume && !this.rtkAwarenessSent && this.acpConfig.rtkEnabled) {
      prompt.push({ type: 'text', text: wrapRtkAwareness() });
      this.rtkAwarenessSent = true;
    }

    if (message.content) {
      prompt.push({ type: 'text', text: message.content });
    }

    for (const attachment of message.attachments ?? []) {
      const block = toAcpPromptBlockFromAttachment(attachment);
      if (block) {
        prompt.push(block);
      }
    }

    return prompt;
  }

  /**
   * Running total of provider-reported tokens for this ACP session (LT-018).
   * ACP reports per-turn usage only, so the aggregate is accumulated here.
   */
  private cumulativeTokens = 0;

  /** One "no usage reported" log line per session, not one per turn (LT-018). */
  private loggedMissingUsage = false;

  /**
   * True once any turn in this session reported real provider usage. Most
   * agents either always report usage or never do; the interesting case is a
   * session that reported it and then stopped, which means a usage frame went
   * missing rather than the agent not supporting usage at all.
   */
  private hasReportedUsage = false;

  /** One missing-usage warning per session, not one per turn. */
  private loggedMissingUsageWarning = false;

  /**
   * Emit a `context` event from a turn's ACP usage (LT-018). The actual
   * shaping (aggregate math, "is there anything to report") lives in
   * {@link buildAcpContextUsageEvent}; this method only owns the session
   * state (`cumulativeTokens`, the once-per-session missing-usage log) and
   * the `emit`/`logger` side effects.
   *
   * Returns whether the agent reported usable usage for this turn, which the
   * caller records alongside a truncated turn as diagnostic context — it is
   * NOT a gate on that path.
   *
   * Missing usage is escalated here, on its own terms, via
   * {@link classifyMissingUsage}: a session that reported usage and then stops
   * has dropped a frame, and a session that never reports usage still warns
   * once its first substantial turn goes unaccounted for. A short turn from an
   * agent that simply does not support usage stays at one info line, because
   * that is unremarkable and warning about it every session would be noise.
   */
  private publishContextUsageFromTurn(
    usage: AcpPromptUsage | undefined,
    durationMs: number,
  ): boolean {
    const { event, cumulativeTokensAfter, usageKeys } = buildAcpContextUsageEvent(
      usage,
      this.cumulativeTokens,
      ACP_CAPABILITIES.contextWindow,
    );

    if (!event) {
      const missingUsageReason = classifyMissingUsage({
        hasReportedUsage: this.hasReportedUsage,
        durationMs,
      });
      if (missingUsageReason && !this.loggedMissingUsageWarning) {
        this.loggedMissingUsageWarning = true;
        logger.warn('ACP turn reported no token usage where usage was expected', {
          adapter: this.getName(),
          reason: missingUsageReason,
          durationMs,
          profile: this.acpConfig.contextCapabilityProfile ?? 'none',
          usageKeyCount: usageKeys?.length ?? 0,
          cumulativeTokens: safeDiagnosticNumber(this.cumulativeTokens),
        });
        return false;
      }
      if (this.loggedMissingUsage) return false;
      this.loggedMissingUsage = true;
      logger.info('ACP turn reported no token usage; context bar stays empty for this session', {
        profile: this.acpConfig.contextCapabilityProfile ?? 'none',
        usageKeyCount: usageKeys?.length ?? 0,
      });
      return false;
    }

    this.hasReportedUsage = true;
    this.cumulativeTokens = cumulativeTokensAfter;
    // Measured occupancy (usage_update) already drives the meter; the turn
    // aggregate would overwrite it with a summed, overstated figure.
    if (!this.measuredOccupancy) this.emit('context', event);
    return true;
  }

  private async sendRequest<TResult>(method: string, params?: unknown, dispatch?: AdapterInputDispatch, writePhase?: { accepted: boolean }): Promise<TResult> {
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
    const line = `${ndjsonSafeStringify(request)}\n`;
    assertAdapterInputCurrent(dispatch);
    dispatch?.beforeProviderDispatch?.();
    assertAdapterInputCurrent(dispatch);

    // Per-method timeout: prompt turns get a loose ceiling; all other RPCs
    // use the default. Without a timeout, a silently dead agent would leave
    // this promise pending forever (root cause of the "Processing…" hang).
    const timeoutMs = method === 'session/prompt'
      ? this.acpConfig.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS
      : this.acpConfig.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    const responsePromise = new Promise<TResult>((resolve, reject) => {
      this.pendingRequests.set(id, {
        method,
        ...(method === 'session/load' && isRecord(params) && typeof params['sessionId'] === 'string'
          ? { loadSessionId: params['sessionId'] } : {}),
        ...(method === 'session/set_config_option' && isRecord(params)
          && typeof params['configId'] === 'string' && typeof params['value'] === 'string'
          ? { configOption: { configId: params['configId'], value: params['value'] } } : {}),
        resolve: (value) => resolve(value as TResult),
        reject,
        timer: this.createRequestTimeout(id, method, timeoutMs),
        timeoutMs,
      });
    });

    // The response can reject while the native write callback is still pending.
    void responsePromise.catch(() => undefined);
    if (method === 'session/prompt') {
      this.currentPromptRequestId = id;
      if (this.currentPrompt) this.currentPrompt.leaseMs = timeoutMs;
    }

    try {
      await this.writeAcpLine(line, method, dispatch, writePhase);
    } catch (error) {
      const err = normalizeAcpInputWriteError(error);
      if (method === 'session/prompt' && err.name !== 'AbortError') markAcpInputWriteFailure(err);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(id);
        pending.reject(err);
      }
      if (this.currentPromptRequestId === id) {
        this.currentPromptRequestId = null;
      }
      throw err;
    }
    return responsePromise;
  }

  private createRequestTimeout(
    id: string,
    method: string,
    timeoutMs: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      // Only act if this pending entry is still the live one; resolve()
      // and reject() paths both clear the timer before settling.
      const entry = this.pendingRequests.get(id);
      if (!entry) return;
      this.pendingRequests.delete(id);
      if (this.currentPromptRequestId === id) {
        this.currentPromptRequestId = null;
      }
      const promptInactivityText = method === 'session/prompt'
        ? ' without a session/update'
        : '';
      // Report what was actually outstanding when the lease expired. The old
      // fixed text asserted an orphaned tool call or permission request even
      // when both had completed and the agent had simply gone quiet, which
      // pointed every later investigation at the wrong subsystem.
      const cause = method === 'session/prompt'
        ? describeAcpPromptTimeoutCause(this.classifyCurrentTurnWait())
        : 'The agent never answered this request.';
      const error = new Error(
        `ACP ${method} request timed out after ${timeoutMs}ms${promptInactivityText} (id=${id}). ${cause}`,
      );
      if (method === 'session/prompt' && this.delegatedLiveness.describe(
        this.acpConfig.activeToolTimeoutMs ?? DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
        this.acpConfig.delegatedTaskTimeoutMs ?? DEFAULT_DELEGATED_TASK_TIMEOUT_MS,
      )) Object.assign(error, { parentSilent: true });
      logger.warn('ACP request timeout', {
        adapter: this.getName(),
        method,
        id,
        timeoutMs,
        cause: acpTextDiagnostic(cause),
      });
      if (method === 'session/prompt') {
        this.cancelTimedOutPrompt(id, timeoutMs);
      }
      entry.reject(error);
    }, timeoutMs);
    // Let the event loop exit even if this timer is still armed (e.g.,
    // during process shutdown); terminate() also explicitly clears it.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    return timer;
  }

  /** Attribute the wait to current-turn permissions and observed work only. */
  private classifyCurrentTurnWait(): AcpTurnWait {
    const turnStartedAt = this.currentPrompt?.startedAt ?? null;
    const wait = classifyAcpTurnWait({
      toolCalls: this.toolCalls.values(),
      permissions: selectCurrentTurnPermissions(
        this.pendingPermissionRequests.values(),
        turnStartedAt,
      ),
    });
    return wait.kind === 'tool' ? { ...wait, ...this.delegatedLiveness.describe(
      this.acpConfig.activeToolTimeoutMs ?? DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
      this.acpConfig.delegatedTaskTimeoutMs ?? DEFAULT_DELEGATED_TASK_TIMEOUT_MS,
    ) } : wait;
  }

  /** Parallel tools settle independently; the generic stuck detector reads this. */
  hasActiveToolCalls(): boolean {
    return this.currentPromptRequestId !== null && hasActiveAcpToolCall(this.toolCalls.values());
  }

  /** ACP owns liveness while its prompt RPC is in flight. */
  hasActiveTurn(): boolean {
    return this.currentPromptRequestId !== null;
  }

  private refreshCurrentPromptTimeout(): void {
    const id = this.currentPromptRequestId;
    if (!id) return;

    const pending = this.pendingRequests.get(id);
    if (!pending || pending.method !== 'session/prompt') return;

    const timeoutMs = this.delegatedLiveness.leaseMs(resolveAcpPromptLeaseMs(
      this.toolCalls.values(),
      pending.timeoutMs,
      this.acpConfig.activeToolTimeoutMs ?? DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
      this.acpConfig.delegatedTaskTimeoutMs ?? DEFAULT_DELEGATED_TASK_TIMEOUT_MS,
    ), this.acpConfig.activeToolTimeoutMs ?? DEFAULT_ACTIVE_TOOL_TIMEOUT_MS,
      this.acpConfig.delegatedTaskTimeoutMs ?? DEFAULT_DELEGATED_TASK_TIMEOUT_MS);
    clearTimeout(pending.timer);
    if (this.currentPrompt) this.currentPrompt.leaseMs = timeoutMs;
    pending.timer = this.createRequestTimeout(id, pending.method, timeoutMs);
  }

  private cancelTimedOutPrompt(id: string, timeoutMs: number): void {
    if (!this.sessionId || !this.process) {
      return;
    }

    void this.sendNotification('session/cancel', { sessionId: this.sessionId })
      .catch((error) => {
        logger.debug('ACP session/cancel after prompt timeout failed; continuing recovery', {
          adapter: this.getName(),
          promptRequestId: id,
          timeoutMs,
          ...safeAcpProtocolDetails({ error }),
        });
      });

    void this.cancelPendingPermissionRequests()
      .catch((error) => {
        logger.debug('ACP permission cancellation after prompt timeout failed; continuing recovery', {
          adapter: this.getName(),
          promptRequestId: id,
          timeoutMs,
          ...safeAcpProtocolDetails({ error }),
        });
      });
  }

  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: AcpJsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.writeAcpLine(`${ndjsonSafeStringify(notification)}\n`, method);
  }

  private async sendResponse(id: AcpJsonRpcId, result: unknown): Promise<void> {
    const response: AcpJsonRpcSuccessResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };
    await this.writeAcpLine(`${ndjsonSafeStringify(response)}\n`, `response:${String(id)}`);
  }

  private async sendErrorResponse(id: AcpJsonRpcId | null, code: number, message: string): Promise<void> {
    const response: AcpJsonRpcErrorResponse = {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    };
    await this.writeAcpLine(`${ndjsonSafeStringify(response)}\n`, `error-response:${String(id)}`);
  }

  private async writeAcpLine(line: string, label: string, dispatch?: AdapterInputDispatch, writePhase?: { accepted: boolean }): Promise<void> {
    if (!this.isRealPipe()) {
      throw new Error(`ACP agent stdin closed before '${label}' could be sent.`);
    }
    assertAdapterInputCurrent(dispatch);
    await this.safeStdinWrite(line, () => { if (writePhase) writePhase.accepted = true; });
  }
}
