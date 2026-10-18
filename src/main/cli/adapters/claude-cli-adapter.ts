/**
 * Claude CLI Adapter - Spawns and manages Claude Code CLI processes
 * Extends BaseCliAdapter for multi-CLI support
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import type { ChildProcess } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  BaseCliAdapter,
  type AdapterCapabilities,
  type AdapterInputDispatch,
  AdapterRuntimeCapabilities,
  CliAdapterConfig,
  CliCapabilities,
  CliStatus,
  CliMessage,
  CliResponse,
  ndjsonSafeStringify,
  type ContextUsageObservation,
  type InterruptResult,
  type ResumeAttemptResult,
  type TurnInterruptCompletion,
} from './base-cli-adapter';
import { NdjsonParser } from '../ndjson-parser';
import { applyClaudeHygieneEnv, resolveClaudeDebugLogging, resolveClaudeFallbackModel } from './claude-env-pack';
import { ClaudeSessionCostLedger } from './claude-session-cost-ledger';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import { ClaudeCompactionObserver } from './claude-compaction-observer';
import { flushClaudeSubagentUsage } from './claude-subagent-usage';
import { nativeTranscriptExists, readLastClaudeCostState } from './claude-transcript-registry';
import { parseClaudeOutput } from './claude-output-parser';
import { createOutputMessage, isCliStderrFailureText } from './base-cli-adapter-utils';
import { InputFormatter } from '../input-formatter';
import { processAttachments, buildMessageWithFiles } from '../file-handler';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic, textDiagnostic } from '../../logging/source-diagnostics';
import { safeDiagnosticNumber } from '../turn-ending-diagnostic-fields';
import { buildAskUserQuestionPrompt, parseAskUserQuestions } from './ask-user-question-prompt';
import { buildClaudeCliArgs, DEFER_MIN_VERSION } from './claude-cli-argv-builder';
import type { CliStreamMessage, CliRateLimitInfo } from '../../../shared/types/cli.types';
import type {
  InstanceStatus,
  FileAttachment
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { buildToolOutcomeMessage } from '../../../shared/types/tool-outcome';
import {
  getProviderModelContextWindow
} from '../../../shared/types/provider.types';
import { getErrorRecoveryManager } from '../../core/error-recovery';
import {
  mergeInputRequiredMetadata,
  toRawCliPayload,
  type DeferredToolUse,
  type ClaudeCliSpawnOptions,
} from './claude-cli-adapter.types';
import {
  EXCLUDE_DYNAMIC_SECTIONS_FLAG,
  detectExcludeDynamicSectionsSupport,
  helpAdvertisesExcludeDynamicSections,
  isVersionAtLeast, resolveClaudeCliVersion,
} from './claude-cli-feature-probes';
import {
  createApprovalTraceId,
  createPermissionKey,
  extractPermissionDetails,
  isPermissionDenialContent,
  type ClaudeToolUseContext,
} from './claude-cli-permission-details';
import { emitClaudeSelfWakeup, emitClaudeSelfWakeupRefusal, sanitizeClaudeToolInput } from './claude-cli-self-wakeup';
import { probeVersionStatus } from './cli-status-probe';
import { ClaudeOneShotLifecycle, ClaudeOneShotTurn, watchClaudeProcessClose } from './claude-one-shot-lifecycle';
import { markProviderDispatchNotStarted } from './provider-dispatch-status';
import { parseClaudeStreamError } from './claude-stream-error';
import { prepareHardenedClaudeLoginEnv } from './claude-hardened-login';
import { applyClaudeResultUsage, type ClaudeResultUsageHost } from './claude-result-usage';
import { processClaudeSystemMessage, type ClaudeSystemMessageHost } from './claude-system-message';
import {
  processClaudeAssistantMessage,
  type ClaudeAssistantMessageHost,
} from './claude-assistant-message';
import {
  ClaudeBackgroundTaskTracker,
  type CliAsyncWorkEvent,
  parseClaudeAsyncWorkToolResult,
  parseClaudeAsyncWorkToolUse,
  parseClaudeTaskNotification,
  parseClaudeToolProgress,
} from './claude-cli-async-work';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import { assertAdapterInputCurrent, createAdapterInputDispatch } from './adapter-input-dispatch';
import { deferUntilResponseUsageSettled } from './deferred-response-usage';
import { ClaudeResidentTurnSettlement } from './claude-resident-turn-settlement';

export type { DeferredToolUse } from './claude-cli-adapter.types';
export type { ClaudeCliSpawnOptions } from './claude-cli-adapter.types';
export type { InputRequiredPayload } from './claude-cli-adapter.types';
export type { ClaudeCliAdapterEvents } from './claude-cli-adapter.types';
export { EXCLUDE_DYNAMIC_SECTIONS_FLAG, helpAdvertisesExcludeDynamicSections };
// Canonical definition lives in claude-cli-argv-builder.ts (needed there for
// the extracted buildArgs logic); re-exported here for backward compatibility.
export { DEFER_MIN_VERSION } from './claude-cli-argv-builder';

const logger = getLogger('ClaudeCliAdapter');

/**
 * Claude CLI Adapter - Implementation for Claude Code CLI
 */
export class ClaudeCliAdapter extends BaseCliAdapter {
  protected override readonly defersInputDispatch = true;
  private parser: NdjsonParser;
  private formatter: InputFormatter | null = null;
  private spawnOptions: ClaudeCliSpawnOptions;
  /** Track pending permission requests to avoid duplicate prompts */
  private pendingPermissions = new Set<string>();
  /** Track permissions that user has already approved (to avoid re-prompting after retry fails) */
  private approvedPermissions = new Set<string>();
  /** Deduplicate AskUserQuestion prompts that can be emitted in multiple stream shapes */
  private emittedAskUserQuestionKeys = new Set<string>();
  /** Map tool_use ids to tool metadata for robust permission-denial parsing */
  private toolUseContexts = new Map<string, ClaudeToolUseContext>();
  /** Background task lifecycle from Claude's `system` task messages (one CLI process). */
  private readonly backgroundTasks = new ClaudeBackgroundTaskTracker();
  /** Cached context window from last result message for accurate streaming percentage */
  private lastKnownContextWindow: number;
  /** Last accurate per-API-call context occupancy (input + cache + output of
   *  the most recent call). Only set from per-call usage — never from the
   *  cumulative result fallback, which overcounts across agentic turns. */
  private lastObservedContextUsage: { used: number; total: number } | null = null;
  /** Floor value from model config — CLI-reported values cannot go below this */
  private readonly contextWindowFloor: number;
  /** Whether we received per-call usage this turn (assistant/system messages). When true,
   *  the result handler should NOT overwrite context usage with cumulative modelUsage totals. */
  private hasPerCallUsageThisTurn = false;
  /** Tracks a deferred tool use when CLI pauses via PreToolUse hook `defer` decision.
   *  Non-null means the CLI process has exited and is waiting to be resumed. */
  private deferredToolUse: DeferredToolUse | null = null;
  /** Cached CLI status so defer-hook feature gating only probes the CLI once per adapter. */
  private cachedCliStatus: CliStatus | null = null;
  /**
   * Cached: whether THIS CLI binary accepts `--exclude-dynamic-system-prompt-sections`,
   * detected from `--help`. `null` until probed. Strictly gates the flag in buildArgs
   * so an older CLI (e.g. on a remote worker) never receives an option it rejects.
   */
  private excludeDynamicSectionsSupported: boolean | null = null;
  private excludeSupportPromise: Promise<boolean> | null = null;
  private cliStatusPromise: Promise<CliStatus> | null = null;
  private lastResumeAttemptResult: ResumeAttemptResult | null = null;
  private lastRateLimitInfo: CliRateLimitInfo | null = null;
  /**
   * State of the most recently *emitted* rate-limit notice, used to suppress
   * duplicates. Tracked against the last emitted notice (not the previous
   * event's status) because the CLI interleaves `allowed` heartbeats between
   * throttled events — a prevStatus compare re-fired on every flip and stacked
   * copies. A new window (different, defined `resetsAt`) re-notifies.
   */
  private lastEmittedRateLimitStatus: string | null = null;
  private lastEmittedRateLimitResetsAt: number | undefined = undefined;
  /**
   * Resolver for the resident-interrupt completion promise.
   * Set when `interrupt()` sends a `control_request{request:{subtype:'interrupt'}}`
   * to stdin; resolved when the matching `control_response{response:{subtype:'success'}}`
   * arrives on stdout or on error/timeout. Non-null only during an active resident interrupt.
   */
  private pendingInterruptResolve: ((result: TurnInterruptCompletion) => void) | null = null;
  /**
   * `request_id` of the in-flight resident interrupt, echoed back by the CLI in
   * the `control_response`. Used to correlate the ack to this interrupt and
   * cleared alongside {@link pendingInterruptResolve}.
   */
  private pendingInterruptRequestId: string | null = null;

  /** LT-047: raw NDJSON for the current resident turn, fed to parseOutput()/completeResponse() at `result`. */
  private residentTurnRawOutput = '';
  /** LT-047 double-fire guard: true while sendMessage()'s own close handler owns completeResponse(). */
  private readonly oneShotLifecycle = new ClaudeOneShotLifecycle();
  private awaitingOneShotCompletion = false;
  /** LT-105: an `error` completed the current resident turn, so its trailing `result` must not. */
  private residentTurnActive = false;
  private residentTurnCompletedByError = false;
  private readonly residentSettlement = new ClaudeResidentTurnSettlement(response => this.settleResponseUsage(response));
  private readonly sessionCostLedger = new ClaudeSessionCostLedger();
  private costSanityWarned = false;
  private readonly compactionObserver = new ClaudeCompactionObserver();

  constructor(options: ClaudeCliSpawnOptions = {}) {
    // Build env passthrough for the spawned CLI process. The PreToolUse hook
    // script reads ORCHESTRATOR_RTK_ENABLED and ORCHESTRATOR_RTK_PATH from env,
    // so they need to be present in the CLI's environment, not the orchestrator's.
    const env: Record<string, string> = { ...options.env };
    applyClaudeHygieneEnv(env, options.sessionId, options);
    if (options.rtk?.enabled && options.rtk.binaryPath) {
      env['ORCHESTRATOR_RTK_ENABLED'] = '1';
      env['ORCHESTRATOR_RTK_PATH'] = options.rtk.binaryPath;
      // Belt-and-braces: also propagate the telemetry opt-out at the CLI level
      env['RTK_TELEMETRY_DISABLED'] = '1';
    }

    const config: CliAdapterConfig = {
      command: 'claude',
      args: [],
      cwd: options.workingDirectory,
      timeout: options.timeout ?? 300000,
      sessionPersistence: true,
      env: Object.keys(env).length > 0 ? env : undefined,
      ...(options.envRemove && options.envRemove.length > 0 ? { envRemove: options.envRemove } : {}),
    };
    super(config);

    // WS14: settings-backed fallback model unless the caller pinned one.
    const fallbackModel = resolveClaudeFallbackModel(options.fallbackModel);
    const debugLogging = resolveClaudeDebugLogging(options.debugLogging);
    this.spawnOptions = {
      ...options,
      ...(fallbackModel ? { fallbackModel } : {}),
      ...(debugLogging ? { debugLogging } : {}),
    };
    this.sessionId = options.sessionId || generateId();
    const knownWindow = getProviderModelContextWindow('claude-cli', options.model);
    this.lastKnownContextWindow = knownWindow;
    this.contextWindowFloor = knownWindow;
    this.parser = new NdjsonParser();
  }

  /** Returns the currently deferred tool use, or null if not paused. */
  getDeferredToolUse(): DeferredToolUse | null { return this.deferredToolUse; }

  /** Clears deferred tool use state (e.g., after successful resume). */
  clearDeferredToolUse(): void { this.deferredToolUse = null; }

  /**
   * Last accurate per-API-call context occupancy. Unlike the cumulative
   * result-line usage (which sums input across every agentic turn), this
   * reflects what actually sits in the context window right now — callers
   * like Loop Mode's context discipline use it to decide when to recycle a
   * persistent session. WS4: returns the discriminated observation —
   * `unknown: not-reported` before the first per-call sample, and
   * `unknown: invalid-sample` for a sample with unusable values.
   */
  override getLastContextUsage(): ContextUsageObservation {
    const sample = this.lastObservedContextUsage;
    if (!sample) return { status: 'unknown', reason: 'not-reported' };
    if (!Number.isFinite(sample.used) || !Number.isFinite(sample.total)
      || sample.used <= 0 || sample.total <= 0) {
      return { status: 'unknown', reason: 'invalid-sample' };
    }
    return { status: 'known', used: sample.used, total: sample.total, source: 'provider-turn' };
  }

  getResumeAttemptResult(): ResumeAttemptResult | null { return this.lastResumeAttemptResult; }

  willResumeSession(): boolean { return this.shouldUseNativeResume(); }
  getTurnCompaction() { return this.compactionObserver.getTurnCompaction(); }

  private beginResumeAttempt(): void {
    this.lastResumeAttemptResult = this.shouldUseNativeResume()
      ? { source: 'native', confirmed: false, requestedSessionId: this.sessionId ?? undefined, forked: this.spawnOptions.forkSession === true }
      : { source: 'fresh-fallback', confirmed: false };
  }

  /** Latest rate-limit telemetry reported by the CLI, or null if none seen. */
  getLastRateLimitInfo(): CliRateLimitInfo | null { return this.lastRateLimitInfo; }

  /** Whether the next spawn should use native `--resume` (B7-guarded). */
  private shouldUseNativeResume(): boolean {
    return Boolean(
      this.spawnOptions.resume
      && this.sessionId
      && nativeTranscriptExists(this.spawnOptions.workingDirectory, this.sessionId),
    );
  }

  // ============ BaseCliAdapter Abstract Implementations ============

  getName(): string { return 'claude-cli'; }

  getCapabilities(): CliCapabilities {
    return {
      streaming: true,
      toolUse: true,
      fileAccess: true,
      shellExecution: true,
      multiTurn: true,
      vision: true,
      codeExecution: true,
      contextWindow: this.lastKnownContextWindow,
      outputFormats: ['ndjson', 'text', 'json']
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: true,
      supportsForkSession: true,
      // Claude CLI is launched with `--print --input-format stream-json`, where
      // slash commands are NOT intercepted by the CLI — they are forwarded to
      // the model as plain user text. There is therefore no programmatic hook
      // we can call to actively trigger a real compaction; this stays false.
      supportsNativeCompaction: false,
      supportsPermissionPrompts: true,
      supportsDeferPermission: this.shouldUsePermissionHook(),
      // Claude CLI auto-compacts internally at the model's own threshold and
      // surfaces that on the output stream. Tell the orchestrator to skip its
      // background/blocking auto-trigger for Claude — only manual user-driven
      // compaction (Compact button / IPC `instance:compact`) should run the
      // strategy chain (which falls through to restart-with-summary because
      // there is no native hook).
      selfManagedAutoCompaction: true,
    };
  }

  /**
   * Resident-session capability descriptor.
   *
   * Claude CLI in `--print --input-format stream-json` mode keeps stdin open,
   * accepts `control_request{interrupt}` to abort a turn without exiting, and
   * then awaits the next `user` message on stdin for the next turn. That makes
   * it a fully resident, steerable server.
   *
   * The adapter sets capabilities to `{true,true,true}` when the process is
   * alive and the formatter is open. The orchestrator uses this to skip the
   * SIGINT + respawn cycle and instead steer via stdin messages.
   */
  override getAdapterCapabilities(): AdapterCapabilities {
    // Only advertise resident capabilities when the process is actually running
    // with an open stdin — not before spawn or after exit — AND the
    // residentClaude is enabled for normal instance spawns; direct adapter
    // callers/tests can still disable it explicitly.
    const residentEnabled = this.spawnOptions.residentClaude === true;
    const isResident = residentEnabled && this.isRealPipe();
    return {
      residentSession: isResident,
      liveInterrupt: isResident,
      liveSteer: isResident,
    };
  }

  override getContextCapabilities(): ProviderContextCapabilities {
    const resident = this.getAdapterCapabilities().residentSession;
    return {
      toolResultControl: 'post-retention',
      toolResultVisibility: 'full',
      transcriptControl: 'none',
      occupancyReporting: resident ? 'current' : 'aggregate-only',
      cumulativeReporting: 'available',
      interruptProof: resident ? 'acknowledged-only' : 'none',
      compactionProof: 'none',
      sameThreadContinuation: resident,
    };
  }

  /**
   * Resident interrupt: sends `control_request{request:{subtype:'interrupt'}}`
   * (with a correlation `request_id`) to stdin instead of SIGINT. The CLI aborts
   * the in-flight turn, stays alive, and replies with the matching
   * `control_response{response:{subtype:'success'}}`. Returns a completion promise
   * that resolves when the response arrives.
   *
   * If the stdin write fails (EPIPE) or the process exits before `control_response`,
   * the completion promise is left pending — the 15s deadline in handleInterruptCompletion
   * causes it to return early, and onInterruptedExit() → respawnAfterInterrupt() owns
   * recovery (resolving respawnPromise only after the new process is ready).
   *
   * Falls back to the base-class SIGINT path when:
   *  - `residentClaude` is not set to true in spawn options, or
   *  - the process or formatter is not currently live (pre-spawn, post-exit).
   */
  override interrupt(): InterruptResult {
    if (this.spawnOptions.residentClaude === true && this.isRealPipe() && this.formatter) {
      // Resident path: protocol-level interrupt, no SIGINT, process stays alive.
      let resolve!: (result: TurnInterruptCompletion) => void;
      const completion = new Promise<TurnInterruptCompletion>((res) => {
        resolve = res;
      });
      this.pendingInterruptResolve = resolve;
      const requestId = `interrupt_${generateId()}`;
      this.pendingInterruptRequestId = requestId;

      this.formatter.sendControlRequest('interrupt', requestId).catch((err: unknown) => {
        // stdin write failed (EPIPE / process already exiting).
        // Clear the resolver WITHOUT resolving it — do NOT settle to 'rejected' here.
        // The process is dying, so handleExit() will fire → exit event →
        // onInterruptedExit() → respawnAfterInterrupt() owns the recovery.
        // Resolving with 'rejected' would cause handleInterruptCompletion() to
        // prematurely settle to idle (before the new process is ready), unblocking
        // sendInput() against a null formatter and losing the queued steer message.
        // The 15s interrupt-completion deadline + force-abort net handle stuck processes.
        logger.warn('Failed to send control_request interrupt; deferring recovery to exit handler', {
          sessionId: this.sessionId,
          ...errorDiagnostic(err),
        });
        if (this.pendingInterruptResolve === resolve) {
          this.pendingInterruptResolve = null;
          this.pendingInterruptRequestId = null;
        }
      });

      logger.info('Sent control_request interrupt (resident path)', {
        sessionId: this.sessionId,
        pid: this.getPid(),
      });
      return { status: 'accepted', completion };
    }

    // Fallback: process is not resident (already dead or pre-spawn) — use SIGINT.
    logger.info('Falling back to SIGINT interrupt (process not resident)', {
      sessionId: this.sessionId,
      pid: this.getPid(),
    });
    return super.interrupt();
  }

  /**
   * Enable resume mode - next spawn will use --resume with the session ID
   * to continue an existing conversation.
   */
  setResume(resume: boolean): void {
    this.spawnOptions.resume = resume;
    logger.debug('Resume mode set', { resume, sessionId: this.sessionId });
  }

  updateMcpConfig(mcpConfig: string[]): void {
    this.spawnOptions.mcpConfig = [...mcpConfig];
    logger.debug('MCP config refreshed for Claude CLI adapter', {
      sessionId: this.sessionId,
      mcpConfigCount: this.spawnOptions.mcpConfig.length,
    });
  }

  /** D2 (#6): per-send tools-disable override; merged into --disallowedTools by buildArgs. */
  private disallowedToolsOverride: readonly string[] | null = null;

  /**
   * D2 (#6) loop cap wrap-up: temporarily deny extra tools on the NEXT spawn
   * (each sendMessage rebuilds argv from spawnOptions, so this takes effect
   * per send). Pass `null` to clear. Purely additive — merged on top of the
   * host denylist and any caller-supplied `disallowedTools`; never removes
   * an existing restriction.
   */
  setDisallowedToolsOverride(tools: readonly string[] | null): void { this.disallowedToolsOverride = tools && tools.length > 0 ? [...tools] : null; }

  /** Private temp dir holding inline-JSON arguments. */
  private inlineArgTempDir: string | null = null;
  /** Login handed to a hardened spawn, keyed to the config dir it was read for. */
  private handedInLogin: { configDir: string | undefined; env: Record<string, string> } | null = null;
  /** Dedup map: inline-JSON content → temp file path (stable across buildArgs calls). */
  private readonly inlineArgFiles = new Map<string, string>();
  private inlineArgTempUsers = 0;

  /**
   * On Windows the CLI is spawned with `shell: true` (it's `claude.cmd`), so the
   * command line passes through cmd.exe — which strips the double-quotes from an
   * inline-JSON argument (Node DEP0190: shell args are concatenated, not escaped),
   * delivering invalid JSON to `claude.exe`. Proven live: `--mcp-config '{"x":1}'`
   * arrived as `{x:1}`. A file PATH has no shell-special characters and survives
   * intact, and `claude --mcp-config` / `--settings` both accept a file path. So
   * on Windows we materialize inline-JSON args (those starting with `{`) to a temp
   * file and pass the path. MCP configs are also materialized on POSIX because
   * workspace connector environment values can contain decrypted secrets.
   */
  private materializeInlineJsonArg(value: string, forceFile = false): string {
    if ((!forceFile && process.platform !== 'win32') || !value.trimStart().startsWith('{')) {
      return value;
    }
    const cached = this.inlineArgFiles.get(value);
    if (cached) {
      return cached;
    }
    if (!this.inlineArgTempDir) {
      this.inlineArgTempDir = mkdtempSync(join(tmpdir(), 'aio-claude-args-'), { encoding: 'utf8' });
    }
    const file = join(this.inlineArgTempDir, `arg-${this.inlineArgFiles.size}.json`);
    writeFileSync(file, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    this.inlineArgFiles.set(value, file);
    return file;
  }

  private cleanupInlineArgTempDir(): void {
    if (!this.inlineArgTempDir) {
      return;
    }
    try {
      rmSync(this.inlineArgTempDir, { recursive: true, force: true });
    } catch {
      /* best-effort; OS temp cleanup is the backstop */
    }
    this.inlineArgTempDir = null;
    this.inlineArgFiles.clear();
  }

  private spawnWithInlineArgCleanup(args: string[]): ChildProcess {
    try {
      const child = this.spawnProcess(args);
      this.inlineArgTempUsers += 1;
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        this.inlineArgTempUsers -= 1;
        if (this.inlineArgTempUsers === 0) this.cleanupInlineArgTempDir();
      };
      child.once('close', release);
      child.once('error', release);
      return child;
    } catch (error) {
      if (this.inlineArgTempUsers === 0) this.cleanupInlineArgTempDir();
      throw error;
    }
  }

  async checkStatus(): Promise<CliStatus> {
    if (this.cachedCliStatus) {
      return this.cachedCliStatus;
    }
    if (this.cliStatusPromise) {
      return this.cliStatusPromise;
    }

    this.cliStatusPromise = probeVersionStatus({
      spawn: () => this.spawnProcess(['--version']),
      path: 'claude',
      timeoutError: 'Timeout checking Claude CLI',
      spawnError: (err) => `Failed to spawn claude: ${err.message}`,
      unavailableError: ({ output }) => `Claude CLI not found or not configured: ${output}`,
      isAvailable: ({ code, output }) => code === 0 || output.includes('claude'),
      includeVersionOnUnavailable: true,
    }).then((status) => {
      this.cachedCliStatus = status;
      this.cliStatusPromise = null;
      return status;
    });

    return this.cliStatusPromise;
  }

  /**
   * Probe `<cli> --help` once (cached) to learn whether this binary supports the
   * exclude-dynamic-sections flag. Fail-safe: any probe failure resolves to
   * `false`, so an unconfirmed CLI simply loses the optimization rather than
   * erroring on an unknown option.
   */
  private detectExcludeDynamicSupport(): Promise<boolean> {
    if (this.excludeDynamicSectionsSupported !== null) {
      return Promise.resolve(this.excludeDynamicSectionsSupported);
    }
    if (this.excludeSupportPromise) {
      return this.excludeSupportPromise;
    }
    this.excludeSupportPromise = detectExcludeDynamicSectionsSupport(
      () => this.spawnProcess(['--help']),
    ).then((supported) => {
      this.excludeDynamicSectionsSupported = supported;
      this.excludeSupportPromise = null;
      return supported;
    }, () => {
      this.excludeDynamicSectionsSupported = false;
      this.excludeSupportPromise = null;
      return false;
    });
    return this.excludeSupportPromise;
  }

  async sendMessage(message: CliMessage): Promise<CliResponse> {
    const admission = this.oneShotLifecycle.prepare();
    const turn = new ClaudeOneShotTurn(this);
    this.oneShotLifecycle.current = turn;
    const startTime = Date.now();
    this.residentSettlement.settle();
    this.resetResidentTurn(false);
    this.outputBuffer = '';
    this.awaitingOneShotCompletion = true; // LT-047: this close handler owns completeResponse()
    try { await this.primeCliVersion(); await this.prepareHardenedLogin(); this.oneShotLifecycle.admit(admission); }
    catch (error) {
      this.awaitingOneShotCompletion = false; this.oneShotLifecycle.finish(turn);
      throw markProviderDispatchNotStarted(error instanceof Error ? error : new Error(String(error)));
    }

    return new Promise<CliResponse>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const allowPartialOnTimeout = message.metadata?.['allowPartialOnTimeout'] === true;
      const continueWhileActiveOnTimeout = message.metadata?.['continueWhileActiveOnTimeout'] === true;
      const activeTimeoutMsRaw = message.metadata?.['activeTimeoutMs'];
      const timeoutMs = this.config.timeout ?? 300000;
      const activeTimeoutMs =
        typeof activeTimeoutMsRaw === 'number' && Number.isFinite(activeTimeoutMsRaw) && activeTimeoutMsRaw > 0
          ? Math.floor(activeTimeoutMsRaw)
          : timeoutMs;
      let hasOutputActivity = false;
      let lastActivityAt = startTime;
      let timeoutExtensionCount = 0;
      let partialTimeoutMetadata: Record<string, unknown> | undefined;

      const parseTurnResponse = (): CliResponse => {
        const response = this.parseOutput(turn.raw);
        response.usage = { ...response.usage, duration: Date.now() - startTime };
        if (partialTimeoutMetadata) {
          response.metadata = { ...response.metadata, ...partialTimeoutMetadata };
          if (!response.content.trim()) response.content = 'Claude CLI reached the iteration timeout after emitting activity but before producing a final assistant message. Treat the workspace state and tool activity as the partial result, then continue from disk state in the next loop iteration.';
        }
        return response;
      };

      const cleanupAfterSettle = (): void => {
        this.process = null;
        this.formatter = null;
        this.parser.reset();
      };

      const finishResolve = (response: CliResponse): void => {
        if (settled) return;
        const failure = turn.failure(response); if (failure) { finishReject(failure, response); return; }
        settled = true;
        this.awaitingOneShotCompletion = false;
        if (timeout) clearTimeout(timeout);
        turn.finish();
        this.completeResponse(response);
        resolve(response);
      };

      const finishReject = (error: Error, response?: CliResponse): void => {
        if (settled) return;
        settled = true;
        this.awaitingOneShotCompletion = false;
        if (timeout) clearTimeout(timeout);
        turn.finish();
        if (response) {
          response.metadata = { ...response.metadata, turnErrored: true };
          this.completeResponse(response, { cancelled: turn.cancelled });
          Object.assign(error, { partialUsage: response.usage });
        }
        reject(error);
      };

      const terminateTimedOutProcess = (): void => {
        this.terminateProcess(false, false).catch((error: unknown) => {
          logger.warn('Failed to terminate timed-out Claude CLI process', {
            sessionId: this.sessionId,
            ...errorDiagnostic(error),
          });
          turn.forceClose?.(error instanceof Error ? error : new Error(String(error)));
        });
      };

      const scheduleTimeout = (delayMs: number): void => {
        timeout = setTimeout(handleTimeout, Math.max(1, delayMs));
      };

      const handleTimeout = (): void => {
        timeout = undefined;
        if (!this.process || settled) {
          return;
        }

        const idleMs = Date.now() - lastActivityAt;
        if (continueWhileActiveOnTimeout && hasOutputActivity && idleMs < activeTimeoutMs) {
          timeoutExtensionCount += 1;
          const nextDelayMs = Math.max(1, Math.min(timeoutMs, activeTimeoutMs - idleMs));
          const idleSeconds = Math.max(0, Math.round(idleMs / 1000));
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content: `Claude CLI is still active (${idleSeconds}s since last output); extending iteration watchdog.`,
            metadata: {
              timeoutExtended: true,
              idleMs,
              activeTimeoutMs,
              timeoutMs,
              extensionCount: timeoutExtensionCount,
            },
          });
          logger.info('Claude CLI reached timeout checkpoint but is still active; extending watchdog', {
            sessionId: this.sessionId,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            extensionCount: timeoutExtensionCount,
          });
          scheduleTimeout(nextDelayMs);
          return;
        }

        if (allowPartialOnTimeout && turn.raw.trim().length > 0) {
          partialTimeoutMetadata = {
            timedOut: true,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            timeoutExtensions: timeoutExtensionCount,
          };
          logger.warn('Claude CLI timeout after partial output; returning partial response', {
            sessionId: this.sessionId,
            timeoutMs,
            idleMs,
            activeTimeoutMs,
            outputLength: turn.raw.length,
          });
          // Settle only after owned stdio finality or the bounded close fallback.
        } else {
          turn.failInput(new Error('Claude CLI timeout'), () => this.terminate(false)); return;
        }

        terminateTimedOutProcess();
      };

      turn.forceClose = error => partialTimeoutMetadata ? finishResolve(parseTurnResponse()) : finishReject(error, this.parseOutput(turn.raw));
      this.beginResumeAttempt();
      const args = this.buildArgs(message);
      this.process = this.spawnWithInlineArgCleanup(args);
      turn.started = Boolean(this.process.pid);
      this.process.once('error', error => turn.failInput(error, () => this.terminate(false)));

      if (this.process.stdin) {
        this.formatter = new InputFormatter(this.process.stdin);

        // Handle stdin errors (EPIPE when process exits before write completes)
        this.process.stdin.on('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EPIPE') {
            logger.warn('stdin EPIPE - CLI process closed before write completed', {
              pid: this.process?.pid,
            });
            return; // Swallow EPIPE — expected when process closes pipe during interrupt/exit
          }
          logger.error('stdin stream error', undefined, errorDiagnostic(error));
          this.emitClassifiedError(error);
        });
      }

      // Prepare and send message content (async setup, then sync event wiring)
      const sendInput = async (): Promise<void> => {
        let finalMessage = message.content;
        const imageAttachments =
          message.attachments?.filter(
            (a) => a.mimeType?.startsWith('image/') || a.type === 'image'
          ) || [];
        const otherAttachments =
          message.attachments?.filter(
            (a) => !a.mimeType?.startsWith('image/') && a.type !== 'image'
          ) || [];

        // Process non-image attachments
        if (otherAttachments.length > 0 && this.config.cwd) {
          const processed = await processAttachments(
            otherAttachments.map((a) => ({
              type: a.mimeType || 'text/plain',
              name: a.name || 'attachment',
              data: a.content || '',
              size: a.content?.length || 0
            })),
            this.sessionId || generateId(),
            this.config.cwd
          );
          finalMessage = buildMessageWithFiles(message.content, processed);
        }

        this.oneShotLifecycle.admit(admission);
        if (this.formatter && this.formatter.isWritable()) {
          await this.formatter.sendMessage(
            finalMessage,
            imageAttachments.length > 0
              ? imageAttachments.map((a) => ({
                  type: a.mimeType || 'image/png',
                  name: a.name || 'image',
                  data: a.content || '',
                  size: a.content?.length || 0
                }))
              : undefined,
            { beforeProviderDispatch: () => { turn.dispatched = true; }, assertCurrent: () => this.oneShotLifecycle.admit(admission) }
          );
          this.formatter.close();
        }
      };

      sendInput().catch(error => turn.failInput(error, () => this.terminate(false)));

      // Handle stdout (NDJSON stream)
      this.process.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return;
        const raw = chunk.toString();
        hasOutputActivity = true;
        lastActivityAt = Date.now();
        turn.raw += raw; this.outputBuffer += raw;

        const messages = this.parser.parse(raw);
        for (const msg of messages) {
          if (msg.type === 'result') turn.noteResult();
          this.processCliMessage(msg);
        }
      });

      // Handle stderr
      this.process.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        if (isCliStderrFailureText(text)) {
          this.emit('output', createOutputMessage('error', text.slice(0, 2000)));
          this.emitClassifiedError(new Error(text));
          return;
        }
        logger.debug('claude stderr', textDiagnostic(text));
      });

      // Handle exit
      this.process.on('close', (code) => {
        if (settled) {
          cleanupAfterSettle();
          return;
        }

        // Flush remaining buffer
        const remaining = this.parser.flush();
        for (const msg of remaining) {
          if (msg.type === 'result') turn.noteResult();
          this.processCliMessage(msg);
        }

        if (code === 0 || turn.raw || turn.error || turn.cancelled) {
          finishResolve(parseTurnResponse());
        } else {
          finishReject(new Error(`Claude CLI exited with code ${code}`));
        }

        cleanupAfterSettle();
      });

      // Loop watchdogs may extend while the child remains active.
      scheduleTimeout(timeoutMs);

      this.process.on('close', () => {
        if (timeout) clearTimeout(timeout);
      });
    }).catch(error => { this.awaitingOneShotCompletion = false; throw turn.beforeStartFailure(error); }).finally(() => this.oneShotLifecycle.finish(turn));
  }

  async *sendMessageStream(message: CliMessage): AsyncIterable<string> {
    await this.primeCliVersion();
    await this.prepareHardenedLogin();
    const args = this.buildArgs(message);
    this.process = this.spawnWithInlineArgCleanup(args);

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);
    }

    // Send the message
    if (this.formatter && this.formatter.isWritable()) {
      await this.formatter.sendMessage(message.content);
      this.formatter.close();
    }

    const stdout = this.process.stdout;
    if (!stdout) return;

    for await (const chunk of stdout) {
      const raw = chunk.toString();
      const messages = this.parser.parse(raw);

      for (const msg of messages) {
        const raw = toRawCliPayload(msg, msg.type);
        if (raw.type === 'assistant' && raw.message?.content) {
          const content = raw.message.content
            .filter((block) => block.type === 'text' && block.text)
            .map((block) => block.text)
            .join('');
          if (content) {
            yield content;
          }
        }
      }
    }
  }

  parseOutput(raw: string): CliResponse {
    return parseClaudeOutput(raw, this.generateResponseId(), (notice) => this.planLimitQuota(notice));
  }

  /**
   * Structured quota diagnostics for a `result` that ended on a plan 429. The
   * reset comes from the preceding `rate_limit_event` (epoch seconds), never
   * from the localised reset text.
   */
  private planLimitQuota(notice: string): { exhausted: true; resetAt?: number; message?: string } {
    const resetsAt = this.lastRateLimitInfo?.resetsAt;
    const resetAt = typeof resetsAt === 'number' && resetsAt * 1000 > Date.now() ? resetsAt * 1000 : undefined;
    return {
      exhausted: true,
      ...(resetAt !== undefined ? { resetAt } : {}),
      ...(notice ? { message: notice.slice(0, 300) } : {}),
    };
  }

  /**
   * Builds the Claude CLI process argv from `spawnOptions`. The actual
   * translation lives in `claude-cli-argv-builder.ts` (extracted so it is
   * independently testable); this method's job is only to gather the few
   * values that require adapter state (native-resume eligibility, permission
   * hook eligibility, CLI version, and the Windows inline-JSON materializer)
   * and hand them over.
   */
  protected buildArgs(_message: CliMessage): string[] {
    const args = buildClaudeCliArgs({
      spawnOptions: this.spawnOptions,
      sessionId: this.sessionId,
      excludeDynamicSectionsSupported: this.excludeDynamicSectionsSupported,
      cliVersion: this.cachedCliStatus?.version ?? null,
      disallowedToolsOverride: this.disallowedToolsOverride,
      shouldUseNativeResume: this.shouldUseNativeResume(),
      shouldUsePermissionHook: this.shouldUsePermissionHook(),
      materializeInlineJsonArg: (value, forceFile) => this.materializeInlineJsonArg(value, forceFile),
    });
    const mode = args.includes('--fork-session') ? 'fork' : args.includes('--resume') ? 'resume' : 'fresh';
    if (mode !== 'resume') this.costSanityWarned = false;
    const seed = mode === 'resume' && this.sessionId
      ? readLastClaudeCostState(this.spawnOptions.workingDirectory, this.sessionId, this.config.env?.['CLAUDE_CONFIG_DIR']) : undefined;
    this.sessionCostLedger.onSpawn(mode, seed?.totalCostUSD ?? this.sessionCostLedger.lastTotalUsd,
      seed?.modelUsage ?? this.sessionCostLedger.lastModelUsage);
    return args;
  }

  protected override completeResponse(response: CliResponse, opts?: { cancelled?: boolean }): void {
    if (!deferUntilResponseUsageSettled(response, () => undefined)) this.settleResponseUsage(response);
    super.completeResponse(response, opts);
  }

  private settleResponseUsage(response: CliResponse): void {
    const usage = response.usage;
    if (usage) {
      const priced = computeTokenCost(this.spawnOptions.model, usage);
      const cost = this.sessionCostLedger.settle(usage.providerSessionTotalUsd, priced, usage.providerModelUsage);
      if (cost !== undefined) usage.cost = cost;
      else delete usage.cost;
      if (this.sessionCostLedger.byModel) usage.byModel = this.sessionCostLedger.byModel;
      if (!this.costSanityWarned && cost !== undefined && priced > 0
        && (cost < 0.8 * priced || (cost > 50 * priced && cost > 5))) {
        this.costSanityWarned = true;
        logger.warn('Claude turn cost differs substantially from main-thread token pricing', { sessionId: this.sessionId, cost, priced });
      }
    }
  }

  // ============ Legacy API Methods (Backward Compatibility) ============

  /** Spawn the resident Claude CLI process. */
  async spawn(): Promise<number> {
    const admission = this.oneShotLifecycle.prepare();
    if (this.process) {
      throw new Error('Process already spawned');
    }

    this.residentSettlement.settle();
    this.resetResidentTurn(false); // LT-047: fresh process, no in-flight turn
    await this.primeCliVersion();
    await this.prepareHardenedLogin();
    this.oneShotLifecycle.admit(admission);
    this.beginResumeAttempt();
    const args = this.buildArgs({ role: 'user', content: '' });

    this.process = this.spawnWithInlineArgCleanup(args);

    if (!this.process.pid) {
      throw new Error('Failed to spawn Claude CLI process');
    }

    // Set up stdin formatter
    if (this.process.stdin) {
      this.formatter = new InputFormatter(this.process.stdin);

      // Handle stdin errors (EPIPE when process exits before write completes)
      this.process.stdin.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EPIPE') {
          logger.warn('stdin EPIPE - CLI process closed before write completed', {
            pid: this.process?.pid,
          });
          return; // Swallow EPIPE — expected when process closes pipe during interrupt/exit
        }
        logger.error('stdin stream error', undefined, errorDiagnostic(error));
        this.emitClassifiedError(error);
      });
    }

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdout(chunk);
    });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this.handleStderr(chunk);
    });

    this.process.on('close', (code, signal) => {
      this.handleExit(code, signal);
    });

    this.process.on('error', (error) => {
      this.emitClassifiedError(error);
    });

    return this.process.pid;
  }

  /** Send a message to the resident CLI. */
  protected override async sendInputImpl(message: string, attachments?: FileAttachment[], _metadata?: CliMessage['metadata'], dispatch?: AdapterInputDispatch): Promise<void> {
    const admission = createAdapterInputDispatch(dispatch);
    assertAdapterInputCurrent(admission);
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Separate images (inline) from other files (need file path)
    const imageAttachments =
      attachments?.filter((a) => a.type?.startsWith('image/')) || [];
    const otherAttachments =
      attachments?.filter((a) => !a.type?.startsWith('image/')) || [];

    let finalMessage = message;

    // For non-image files, save to working directory and add file paths to message
    if (otherAttachments.length > 0 && this.config.cwd) {
      const processed = await processAttachments(
        otherAttachments,
        this.sessionId || generateId(),
        this.config.cwd
      );
      assertAdapterInputCurrent(admission);
      finalMessage = buildMessageWithFiles(message, processed);
    }

    this.resetResidentTurn(true); // LT-047: new turn, drop stale prior output
    await this.formatter.sendMessage(
      finalMessage,
      imageAttachments.length > 0 ? imageAttachments : undefined,
      admission,
    );
    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Send raw text input (for permission prompts, etc.)
   * When using stream-json input format, all responses need to be JSON formatted as user messages
   *
   * NOTE: Permission approvals from UI dialogs don't actually send to CLI stdin because
   * Claude CLI's permission system doesn't support programmatic approval in print mode.
   * The CLI already returned a permission denial error and continued - it's not waiting for input.
   * To approve tool use, users must enable YOLO mode which restarts the session with
   * --dangerously-skip-permissions.
   */
  async sendRaw(text: string, permissionKey?: string): Promise<void> {
    if (!this.formatter || !this.formatter.isWritable()) {
      throw new Error('CLI not ready for input');
    }

    // Clear the pending permission if one was specified
    if (permissionKey && this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      logger.debug('Cleared pending permission', { permissionKey: textDiagnostic(permissionKey) });
    }

    // Check if this is a permission approval response
    const isPermissionApproval = text.toLowerCase().includes('permission granted') ||
                                  text.toLowerCase().includes('allow') ||
                                  text.toLowerCase().startsWith('y');

    // Check if this is a permission denial response
    const isPermissionDenial = text.toLowerCase().includes('permission denied') ||
                               text.toLowerCase().includes('do not perform') ||
                               text.toLowerCase().startsWith('n');

    if (permissionKey && (isPermissionApproval || isPermissionDenial)) {
      // Track permission response for future reference
      if (isPermissionApproval) {
        this.approvedPermissions.add(permissionKey);
        logger.debug('Marked permission as approved', { permissionKey: textDiagnostic(permissionKey) });
        logger.info('Note - CLI is not waiting for input. User should enable YOLO mode to allow this tool.');
      } else {
        logger.debug('Permission denied by user', { permissionKey: textDiagnostic(permissionKey) });
      }

      // Don't send permission responses to stdin - the CLI isn't waiting for them
      // Just update status back to idle/busy
      this.emit('status', 'idle' as InstanceStatus);
      return;
    }

    // For regular user input (not permission responses), send as JSON user message
    const userMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: text
      }
    };
    const jsonMessage = ndjsonSafeStringify(userMessage);
    logger.debug('Sending as user message', {
      contentLength: text.length,
      jsonMessageLength: jsonMessage.length,
      ...textDiagnostic(text),
    });
    this.resetResidentTurn(true); // LT-047: see sendInputImpl
    await this.formatter.sendRaw(jsonMessage);

    this.emit('status', 'busy' as InstanceStatus);
  }

  /**
   * Clear a pending permission (called when user responds to permission prompt)
   */
  clearPendingPermission(permissionKey: string): void {
    if (this.pendingPermissions.has(permissionKey)) {
      this.pendingPermissions.delete(permissionKey);
      logger.debug('Cleared pending permission', { permissionKey: textDiagnostic(permissionKey) });
    }
  }

  // ============ Private Helper Methods ============

  private resetResidentTurn(active = true): void {
    this.residentTurnActive = active;
    this.residentSettlement.markInput();
    this.compactionObserver.reset();
    this.residentTurnRawOutput = '';
    this.residentTurnCompletedByError = false;
  }

  /** LT-047/LT-105: complete the current resident turn once, from its accumulated NDJSON. */
  private completeResidentTurn(metadata?: Record<string, unknown>): void {
    if (!this.residentTurnActive) return;
    this.residentTurnActive = false;
    const response = this.parseOutput(this.residentTurnRawOutput);
    this.residentTurnRawOutput = '';
    if (metadata) response.metadata = { ...response.metadata, ...metadata };
    if (metadata?.['turnErrored']) this.residentSettlement.defer(response);
    this.completeResponse(response);
  }

  override terminate(graceful = true): Promise<void> {
    return this.terminateProcess(graceful);
  }

  // A partial watchdog result stops transport without changing its semantic outcome.
  private terminateProcess(graceful: boolean, cancelCurrent = true): Promise<void> {
    return this.oneShotLifecycle.terminate(async () => {
      const turn = this.oneShotLifecycle.current;
      await this.residentSettlement.drain(); await turn?.drain();
      const residentClose = !turn && this.residentSettlement.pending && this.process ? watchClaudeProcessClose(this.process) : undefined;
      try { await super.terminate(graceful); await turn?.waitForClose(); }
      finally { await residentClose?.(); this.residentSettlement.settle(); }
    }, cancelCurrent);
  }

  private emitClassifiedError(error: Error): void {
    if (!this.awaitingOneShotCompletion && this.residentTurnActive && !this.residentTurnCompletedByError) {
      this.completeResidentTurn({ turnErrored: true }); this.residentTurnCompletedByError = true;
    }
    getErrorRecoveryManager().classifyError(error, 'claude-cli-adapter');
    this.emit('error', error);
  }

  private handleStdout(chunk: Buffer): void {
    const raw = chunk.toString();

    // Log ALL message types coming through for debugging
    const typeMatch = raw.match(/"type"\s*:\s*"([^"]+)"/g);
    if (typeMatch) {
      logger.debug('Message types in chunk', { typeMatchCount: typeMatch.length });
    }

    // Log raw output for debugging permission and elicitation issues
    if (raw.includes('input_required') || raw.includes('elicitation') || raw.includes('permission') || raw.includes('approve') ||
        raw.includes('denied') || raw.includes('not allowed') || raw.includes('is_error')) {
      logger.debug('RAW STDOUT (permission-related)', {
        rawLength: raw.length,
        ...textDiagnostic(raw),
      });
    }

    const messages = this.parser.parse(raw);
    logger.debug('Parsed messages from stdout', {
      count: messages.length,
      types: messages.map(m => typeof m.type === 'string' ? textDiagnostic(m.type) : { typeKind: 'non-string' })
    });

    for (const message of messages) {
      // A result belongs to the pending failed turn even if newer input has
      // already reset the current buffer. Append message-by-message so chunks
      // containing several turn boundaries cannot leak future usage backwards.
      if (!(message.type === 'result' && this.residentSettlement.pending)) this.residentTurnRawOutput += JSON.stringify(message) + '\n';
      // Log all message types for debugging
      if (message.type === 'input_required') {
        logger.debug('Parsed input_required message, forwarding to processCliMessage');
      }
      this.processCliMessage(message);
    }
  }

  private handleStderr(chunk: Buffer): void {
    const errorText = chunk.toString().trim();
    if (!errorText) return;

    if (errorText.includes('permission') || errorText.includes('approve') || errorText.includes('allow') || errorText.includes('y/n')) {
      logger.debug('STDERR contains permission-like content', {
        errorLength: errorText.length,
        ...textDiagnostic(errorText),
      });
    }

    if (isCliStderrFailureText(errorText)) {
      this.emit('output', createOutputMessage('error', errorText));
      return;
    }
    logger.debug('handleStderr received', textDiagnostic(errorText));
  }

  private handleExit(code: number | null, signal: string | null): void {
    // Flush any remaining parser buffer
    const remaining = this.parser.flush();
    for (const message of remaining) {
      if (!(message.type === 'result' && this.residentSettlement.pending)) this.residentTurnRawOutput += JSON.stringify(message) + '\n';
      this.processCliMessage(message);
    }
    this.residentSettlement.settle();
    this.residentTurnActive = false;

    // Clear any in-flight resident interrupt WITHOUT resolving it.
    // Do NOT resolve with 'rejected' here: the 'exit' event (emitted below) triggers
    // onInterruptedExit() → respawnAfterInterrupt(), which resolves respawnPromise only
    // after the new process is ready. Resolving the completion promise here with 'rejected'
    // would cause handleInterruptCompletion() to prematurely settle the instance to idle,
    // unblocking sendInput() against a null formatter and losing the queued steer message.
    // handleInterruptCompletion() will time out via its 15s deadline and return early;
    // the force-abort net (30s) is cancelled by resolveRespawnPromise() in respawnAfterInterrupt().
    if (this.pendingInterruptResolve) {
      this.pendingInterruptResolve = null;
      this.pendingInterruptRequestId = null;
    }

    this.process = null;
    this.formatter = null;
    this.parser.reset();
    this.backgroundTasks.reset();

    // If we have a deferred tool use, this is an expected exit (code 0) after
    // the hook returned `defer`. Don't trigger respawn — the resume flow handles it.
    if (this.deferredToolUse) {
      logger.info('Process exited with deferred tool use pending', {
        toolName: typeof this.deferredToolUse.toolName === 'string' ? textDiagnostic(this.deferredToolUse.toolName) : undefined,
        toolUseId: this.deferredToolUse.toolUseId,
        sessionId: this.deferredToolUse.sessionId,
        exitCode: code,
      });
    }

    this.emit('exit', code, signal);
  }

  private processCliMessage(message: CliStreamMessage): void {
    const raw = toRawCliPayload(message, message.type);
    switch (message.type) {
      case 'assistant': {
        const streamError = parseClaudeStreamError(raw);
        if (streamError) { this.emitClassifiedError(streamError.error); break; }
        this.residentSettlement.settle();
        if (!this.awaitingOneShotCompletion && !(raw as { parent_tool_use_id?: unknown }).parent_tool_use_id) this.residentTurnActive = true;
        // LT-105: assistant output after an errored turn means the CLI started a new turn itself.
        this.residentTurnCompletedByError = false;
        processClaudeAssistantMessage(this as unknown as ClaudeAssistantMessageHost, message, raw);
        break;
      }

      case 'user': {
        const userMsg = raw;

        // Check for permission denial in tool_result content
        // Claude CLI returns these as user messages with tool_result content when permissions are denied
        if (userMsg.message?.content && Array.isArray(userMsg.message.content)) {
          for (const block of userMsg.message.content) {
            if (block.type === 'text' && block.text) {
              this.emitAsyncWork(parseClaudeTaskNotification(block.text));
            }

            // LT-062: below only turns a tool_result into a visible 'output'
            // message on the permission-denial branch, so the loop detector
            // never saw an ordinary success/failure. Raw-emit it instead —
            // same channel AcpCliAdapter already uses, transcript untouched.
            if (block.type === 'tool_result' && block.tool_use_id && typeof block.content === 'string') {
              const context = this.toolUseContexts.get(block.tool_use_id);
              emitClaudeSelfWakeupRefusal(this, context?.name, block.tool_use_id, block.is_error === true);
              this.emitAsyncWork(parseClaudeAsyncWorkToolResult(
                block.tool_use_id,
                context?.name ?? '',
                block.content,
                block.is_error === true,
                context?.input,
              ));
              this.emit('tool_result', {
                id: block.tool_use_id,
                name: context?.name ?? '',
                arguments: context?.input ?? {},
                result: block.content,
              });
              // LT-196: the raw emit above is live-only and is discarded, so the
              // archived transcript carried no per-call outcome and the
              // correction miner found nothing for Claude. Record the outcome as
              // a transcript-invisible message. This does NOT undo LT-062 — the
              // record is a distinct `tool_outcome` type that no renderer
              // displays, not a visible `tool_result`.
              this.emit('output', buildToolOutcomeMessage(
                {
                  toolUseId: block.tool_use_id,
                  isError: block.is_error === true,
                  toolName: context?.name ?? '',
                  resultText: block.content,
                },
                generateId(),
                Date.now(),
              ));
            }

            // Log ALL tool_result errors for diagnostic visibility
            if (
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string'
            ) {
              logger.info('[APPROVAL_TRACE] tool_result_error_received', {
                toolUseId: block.tool_use_id,
                contentLength: block.content.length,
                ...textDiagnostic(block.content),
                isPermissionDenial: isPermissionDenialContent(block.content)
              });
            }

            // YOLO runs with --dangerously-skip-permissions: the CLI cannot ask
            // for a permission grant, so denial-looking text here is either the
            // command's own output or an explicit settings deny rule — and the
            // "add allow rule + restart" recovery can fix neither. Restarting a
            // healthy YOLO session over it destroys context for nothing.
            if (
              !this.spawnOptions.yoloMode &&
              block.type === 'tool_result' &&
              block.is_error === true &&
              typeof block.content === 'string' &&
              isPermissionDenialContent(block.content)
            ) {
              logger.debug('Permission denial detected in tool_result', {
                toolUseId: block.tool_use_id,
                contentLength: block.content.length,
                ...textDiagnostic(block.content)
              });

              const { action, path, displayPath } = extractPermissionDetails(
                block.content,
                block.tool_use_id,
                this.toolUseContexts
              );

              // Capture the authoritative tool name (e.g. 'Edit', 'Write') from the
              // original tool_use, so the renderer can request a precise settings.json
              // allow-rule on user approval.
              const denialToolContext = block.tool_use_id
                ? this.toolUseContexts.get(block.tool_use_id)
                : undefined;
              const denialToolName = denialToolContext?.name;

              // Create a unique key for this permission request to avoid duplicate prompts
              const permissionKey = createPermissionKey(action, path);

              // Skip if we already have a pending request for this exact permission
              if (this.pendingPermissions.has(permissionKey)) {
                logger.debug('Skipping duplicate permission prompt', {
                  permissionKey: textDiagnostic(permissionKey),
                  action: textDiagnostic(action),
                  path: textDiagnostic(displayPath)
                });
                this.forgetToolUse(block.tool_use_id);
                continue;
              }

              // Skip if user already approved this permission (retry still failed but don't re-prompt)
              if (this.approvedPermissions.has(permissionKey)) {
                logger.debug('User already approved this permission, not re-prompting', {
                  permissionKey: textDiagnostic(permissionKey),
                  action: textDiagnostic(action),
                  path: textDiagnostic(displayPath)
                });
                // Emit a system message to inform user - only once per permission
                const hintKey = `hint:${permissionKey}`;
                if (!this.approvedPermissions.has(hintKey)) {
                  this.approvedPermissions.add(hintKey);
                  this.emit('output', {
                    id: generateId(),
                    timestamp: Date.now(),
                    type: 'system',
                    content: `Permission for "${action} ${displayPath}" was denied by the CLI. To allow this action, enable YOLO mode (⚡ button) which auto-approves all tool use for this session.`,
                    metadata: { permissionHint: true, suggestYolo: true }
                  });
                }
                this.forgetToolUse(block.tool_use_id);
                continue;
              }

              // Track this permission request
              this.pendingPermissions.add(permissionKey);
              logger.debug('Added to pending permissions', {
                permissionKey: textDiagnostic(permissionKey),
                action: textDiagnostic(action),
                path: textDiagnostic(displayPath)
              });

              const inputRequestId = generateId();
              const approvalTraceId = createApprovalTraceId('permission');
              const prompt = `Permission required: Claude wants to ${action} ${displayPath}. Choose Always to add a Claude allow rule and restart the session, or reject to continue with this action denied.`;
              const timestamp = message.timestamp || Date.now();

              logger.debug('Emitting input_required for permission denial', {
                inputRequestId,
                action: textDiagnostic(action),
                path: textDiagnostic(displayPath)
              });
              logger.info('[APPROVAL_TRACE] adapter_emit_permission_denial', {
                approvalTraceId,
                instanceSessionId: this.sessionId,
                requestId: inputRequestId,
                permissionKey: textDiagnostic(permissionKey),
                action: textDiagnostic(action),
                path: textDiagnostic(displayPath),
                toolUseId: block.tool_use_id
              });

              this.emit('status', 'waiting_for_input' as InstanceStatus);

              // Emit the input_required event for UI to handle.
              // `path` is the UI-friendly (possibly truncated) string; `full_path`
              // carries the untruncated value so downstream writers (e.g. the
              // self-permission granter) can build an exact-path rule. `tool_name`
              // is the original Claude CLI tool (Write/Edit/Read/Bash), which maps
              // 1:1 to the settings.json permissions format `Tool(pattern)`.
              this.emit('input_required', {
                id: inputRequestId,
                prompt,
                timestamp,
                metadata: {
                  type: 'permission_denial',
                  tool_use_id: block.tool_use_id,
                  action,
                  path: displayPath,
                  full_path: path,
                  tool_name: denialToolName,
                  permissionKey, // Include for cleanup after response
                  approvalTraceId,
                  traceStage: 'adapter:permission_denial_emit'
                }
              });

              // Also emit as system output for visibility in chat
              this.emit('output', {
                id: inputRequestId,
                timestamp,
                type: 'system',
                content: prompt,
                metadata: {
                  requiresInput: true,
                  permissionDenial: true,
                  approvalTraceId,
                  traceStage: 'adapter:permission_denial_output'
                }
              });

              logger.debug('Permission denial handling complete');
              this.forgetToolUse(block.tool_use_id);
            }
          }
          break;
        }
        if (typeof message.content === 'string' && message.content.trim()) {
          this.emitAsyncWork(parseClaudeTaskNotification(message.content));
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'user',
            content: message.content
          });
        }
        break;
      }

      case 'system':
        processClaudeSystemMessage(this as unknown as ClaudeSystemMessageHost, message, raw);
        break;

      case 'tool_use':
        this.rememberToolUse(message.tool.id, message.tool.name, message.tool.input);
        this.emitAsyncWork(parseClaudeAsyncWorkToolUse(
          message.tool.name,
          message.tool.id,
          message.tool.input,
        ));
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_use',
          content: `Using tool: ${message.tool.name}`,
          metadata: { ...message.tool, input: sanitizeClaudeToolInput(message.tool.name, message.tool.input ?? {}) }
        });
        if (message.tool.name === 'AskUserQuestion') {
          this.emitAskUserQuestionInputRequired(
            message.tool.id,
            message.tool.input || {},
            message.timestamp || Date.now()
          );
        }
        break;

      case 'tool_result': {
        const context = this.toolUseContexts.get(message.tool_use_id);
        emitClaudeSelfWakeupRefusal(this, context?.name, message.tool_use_id, message.is_error === true);
        this.emitAsyncWork(parseClaudeAsyncWorkToolResult(
          message.tool_use_id,
          context?.name ?? '',
          message.content,
          message.is_error === true,
          context?.input,
        ));
        this.forgetToolUse(message.tool_use_id);
        this.emit('output', {
          id: generateId(),
          timestamp: message.timestamp || Date.now(),
          type: 'tool_result',
          content: message.content,
          metadata: {
            tool_use_id: message.tool_use_id,
            is_error: message.is_error
          }
        });
        break;
      }

      case 'tool_progress': {
        this.emitAsyncWork(parseClaudeToolProgress(raw));
        break;
      }

      case 'result': {
        const resultMsg = raw;
        flushClaudeSubagentUsage(this);
        if (this.residentSettlement.pending) {
          const newerInput = this.residentSettlement.settle(this.parseOutput(JSON.stringify(resultMsg)).usage);
          this.residentTurnCompletedByError = false;
          if (!newerInput) this.residentTurnActive = false;
          if (!newerInput) applyClaudeResultUsage(this as unknown as ClaudeResultUsageHost, resultMsg);
          if (!newerInput) { this.hasPerCallUsageThisTurn = false; this.emit('status', 'idle' as InstanceStatus); }
          break;
        }

        // VALIDATED: Check for tool_deferred stop reason (Claude CLI 2.1.98+).
        // When a PreToolUse hook returns `defer`, the CLI emits a result with
        // stop_reason: "tool_deferred" and a deferred_tool_use object, then exits.
        if (resultMsg.stop_reason === 'tool_deferred' && resultMsg.deferred_tool_use) {
          const deferred = resultMsg.deferred_tool_use;
          this.deferredToolUse = {
            toolName: deferred.name,
            toolInput: deferred.input || {},
            toolUseId: deferred.id,
            sessionId: resultMsg.session_id || this.sessionId || '',
            deferredAt: Date.now(),
          };

          logger.info('Tool use deferred by hook', {
            toolName: typeof deferred.name === 'string' ? textDiagnostic(deferred.name) : undefined,
            toolUseId: deferred.id,
            sessionId: this.deferredToolUse.sessionId,
          });

          // Prefer the tool input captured from the assistant message (via
          // toolUseContexts) over the deferred_tool_use.input field, since
          // both should be identical but the captured copy is always a plain
          // object (already normalized by rememberToolUse). Fall back to
          // deferred.input if the context entry is absent, and omit the field
          // entirely if neither source is available (fail-soft).
          const capturedContext = this.toolUseContexts.get(deferred.id);
          const resolvedToolInput: Record<string, unknown> | undefined =
            capturedContext?.input ?? (deferred.input ? deferred.input : undefined);

          // Build a human-readable prompt with the actual command
          const toolSummary = deferred.name === 'Bash' && resolvedToolInput?.['command']
            ? `Bash: \`${String(resolvedToolInput['command'])}\``
            : deferred.name;

          this.emit('status', 'waiting_for_permission' as InstanceStatus);
          this.emit('input_required', {
            id: generateId(),
            prompt: `Permission required: Claude wants to run ${toolSummary}`,
            timestamp: Date.now(),
            metadata: {
              type: 'deferred_permission',
              tool_name: deferred.name,
              ...(resolvedToolInput !== undefined ? { tool_input: resolvedToolInput } : {}),
              tool_use_id: deferred.id,
              session_id: resultMsg.session_id,
            },
          });

          // Don't process further — the instance is paused, awaiting user decision
          break;
        }

        applyClaudeResultUsage(this as unknown as ClaudeResultUsageHost, resultMsg);

        // LT-047: resident turns never reached completeResponse()/'complete', starving
        // cost/telemetry/hooks. Reuse parseOutput() as one-shot mode does; guarded below.
        // LT-105: skip when an `error` already completed this turn.
        if (!this.awaitingOneShotCompletion && !this.residentTurnCompletedByError) {
          this.completeResidentTurn();
        }
        this.residentTurnCompletedByError = false;

        // Reset for next turn
        this.hasPerCallUsageThisTurn = false;
        this.emit('status', 'idle' as InstanceStatus);
        break;
      }

      case 'error': {
        const streamError = parseClaudeStreamError(raw);
        this.emitClassifiedError(streamError?.error ?? new Error('Claude CLI reported an unknown error'));
        break;
      }

      case 'input_required': {
        const inputRequiredMetadataKeys = 'metadata' in message
          && message.metadata
          && typeof message.metadata === 'object'
          ? Object.keys(message.metadata)
          : [];
        logger.debug('Input_required message received', {
          promptLength: typeof message.prompt === 'string' ? message.prompt.length : 0,
          metadataKeyCount: inputRequiredMetadataKeys.length
        });

        this.emit('status', 'waiting_for_input' as InstanceStatus);
        const inputRequestId = generateId();
        const approvalTraceId = createApprovalTraceId('input_required');
        const prompt = message.prompt || 'Input required';
        const timestamp = message.timestamp || Date.now();

        logger.debug('Processing input_required', {
          inputRequestId,
          promptLength: prompt.length,
          ...textDiagnostic(prompt)
        });
        logger.info('[APPROVAL_TRACE] adapter_emit_input_required', {
          approvalTraceId,
          instanceSessionId: this.sessionId,
          requestId: inputRequestId,
          promptLength: prompt.length
        });

        // Emit the input_required event for UI to handle
        this.emit('input_required', {
          id: inputRequestId,
          prompt,
          timestamp,
          metadata: mergeInputRequiredMetadata(message, {
            approvalTraceId,
            traceStage: 'adapter:input_required_emit',
          }),
        });

        // Also emit as system output for visibility in chat
        this.emit('output', {
          id: inputRequestId,
          timestamp,
          type: 'system',
          content: prompt,
          metadata: {
            requiresInput: true,
            approvalTraceId,
            traceStage: 'adapter:input_required_output'
          }
        });
        logger.debug('Input_required handling complete');
        break;
      }

      case 'elicitation': {
        // MCP elicitation — an MCP server is requesting structured input
        // (e.g. OAuth consent, configuration form, credential entry).
        // Surface this as an input_required event so the UI can present a form.
        const elicitationRaw = raw as {
          server_name?: string;
          message?: string;
          schema?: Record<string, unknown>;
          request_id?: string;
        };
        const serverName = elicitationRaw.server_name || 'MCP server';
        const elicitationMsg = elicitationRaw.message || 'An MCP server requires input';
        const elicitationTimestamp = message.timestamp || Date.now();
        const elicitationId = generateId();

        logger.info('MCP elicitation received', {
          serverName: typeof serverName === 'string' ? textDiagnostic(serverName) : undefined,
          ...textDiagnostic(elicitationMsg),
          hasSchema: Boolean(elicitationRaw.schema),
          requestId: elicitationRaw.request_id
        });

        this.emit('status', 'waiting_for_input' as InstanceStatus);

        this.emit('input_required', {
          id: elicitationId,
          prompt: `[${serverName}] ${elicitationMsg}`,
          timestamp: elicitationTimestamp,
          metadata: {
            type: 'mcp_elicitation',
            serverName,
            schema: elicitationRaw.schema,
            requestId: elicitationRaw.request_id
          }
        });

        this.emit('output', {
          id: elicitationId,
          timestamp: elicitationTimestamp,
          type: 'system',
          content: `MCP server "${serverName}" requests input: ${elicitationMsg}`,
          metadata: {
            requiresInput: true,
            mcpElicitation: true,
            serverName,
            schema: elicitationRaw.schema
          }
        });
        break;
      }

      case 'rate_limit_event': {
        // Anthropic usage telemetry. `status: 'allowed'` is the steady state and
        // arrives every turn — keep it at debug so it doesn't spam as an
        // "unrecognized message". Only surface a user-visible notice the first
        // time the status flips into an actually-throttled state, so a stalled
        // session shows *why* instead of going silent.
        const info = (raw as { rate_limit_info?: CliRateLimitInfo }).rate_limit_info ?? null;
        this.lastRateLimitInfo = info;
        if (info) this.emit('rate-limit-telemetry', info); // account-pool quota bridge
        const status = info?.status;
        const throttled = Boolean(status && status !== 'allowed');
        const resetsAtMs = typeof info?.resetsAt === 'number' ? info.resetsAt * 1000 : undefined;
        // Dedupe against the last *emitted* notice: an unchanged throttle status
        // emits once even across interleaved `allowed` heartbeats or bare
        // repeats that omit window fields. Only a new window (explicitly
        // different, defined `resetsAt`) re-notifies. We deliberately do NOT
        // reset on `allowed` — that reset is what let duplicates stack.
        const isNewWindow =
          resetsAtMs !== undefined &&
          this.lastEmittedRateLimitResetsAt !== undefined &&
          resetsAtMs !== this.lastEmittedRateLimitResetsAt;
        const alreadyNotified =
          this.lastEmittedRateLimitStatus === status && !isNewWindow;
        if (throttled && !alreadyNotified) {
          this.lastEmittedRateLimitStatus = status ?? null;
          this.lastEmittedRateLimitResetsAt = resetsAtMs;
          const resetText = resetsAtMs ? new Date(resetsAtMs).toLocaleTimeString() : 'unknown';
          logger.warn('Provider rate limit active', {
            status: typeof status === 'string' ? textDiagnostic(status) : undefined,
            rateLimitType: typeof info?.rateLimitType === 'string' ? textDiagnostic(info.rateLimitType) : undefined,
            overageStatus: typeof info?.overageStatus === 'string' ? textDiagnostic(info.overageStatus) : undefined,
            resetsAt: safeDiagnosticNumber(resetsAtMs),
          });
          this.emit('output', {
            id: generateId(),
            timestamp: message.timestamp || Date.now(),
            type: 'system',
            content: `Provider rate limit "${status}" (${info?.rateLimitType ?? 'window'}). Resets at ${resetText}.`,
            metadata: {
              rateLimit: true,
              status,
              rateLimitType: info?.rateLimitType,
              resetsAt: resetsAtMs,
            },
          });
        } else {
          logger.debug('Rate limit telemetry', {
            status: typeof status === 'string' ? textDiagnostic(status) : undefined,
            rateLimitType: typeof info?.rateLimitType === 'string' ? textDiagnostic(info.rateLimitType) : undefined,
            resetsAt: safeDiagnosticNumber(info?.resetsAt),
          });
        }
        break;
      }

      case 'control_response': {
        // Resident-interrupt acknowledgement from Claude CLI.
        // Resolves the completion promise returned by interrupt() so the
        // orchestrator can proceed without a respawn cycle.
        //
        // Wire shape (stream-json control protocol): the payload is nested under
        // `response` and correlated by `request_id`:
        //   {type:'control_response', response:{subtype:'success'|'error', request_id, error?}}
        // A defensive fallback also accepts a flat {subtype,status,error} shape.
        const ctrl = raw as {
          response?: { subtype?: string; request_id?: string; error?: string };
          subtype?: string;
          status?: string;
          error?: string;
          request_id?: string;
        };
        const resp = ctrl.response ?? ctrl;
        const respId = resp.request_id ?? ctrl.request_id;
        // Correlate to the in-flight interrupt: match the echoed request_id when
        // present; if the CLI omits it, fall back to "any ack while one interrupt
        // is pending" (interrupts are serialized, so at most one is in flight).
        const matchesPending =
          this.pendingInterruptResolve !== null &&
          (respId === undefined ||
            this.pendingInterruptRequestId === null ||
            respId === this.pendingInterruptRequestId);
        if (matchesPending && this.pendingInterruptResolve) {
          const resolve = this.pendingInterruptResolve;
          this.pendingInterruptResolve = null;
          this.pendingInterruptRequestId = null;
          const subtype = resp.subtype ?? ctrl.subtype;
          const isError = subtype === 'error' || ctrl.status === 'error';
          if (!isError) {
            logger.info('Resident interrupt acknowledged by CLI', { sessionId: this.sessionId, requestId: respId });
            resolve({ status: 'interrupted' });
          } else {
            const reason = resp.error ?? ctrl.error ?? `control_response subtype=${subtype ?? ctrl.status}`;
            logger.warn('control_response interrupt non-success', {
              subtype: typeof subtype === 'string' ? textDiagnostic(subtype) : undefined,
              status: typeof ctrl.status === 'string' ? textDiagnostic(ctrl.status) : undefined,
              ...errorDiagnostic(reason),
              sessionId: this.sessionId,
            });
            resolve({ status: 'rejected', reason });
          }
        } else {
          logger.debug('control_response received with no matching pending interrupt', {
            respId,
            pendingRequestId: this.pendingInterruptRequestId,
            subtype: errorDiagnostic(resp.subtype ?? ctrl.subtype),
          });
        }
        break;
      }

      default: {
        const unhandled = message as { type: string };
        logger.warn('Unrecognized CLI message type', {
          type: typeof unhandled.type === 'string' ? textDiagnostic(unhandled.type) : { typeKind: typeof unhandled.type },
          keyCount: Object.keys(message).length,
          ...textDiagnostic(JSON.stringify(message))
        });
        break;
      }
    }
  }

  private emitAskUserQuestionInputRequired(
    toolUseId: string | undefined,
    input: unknown,
    timestamp: number,
    fallbackText?: string
  ): void {
    const prompt = buildAskUserQuestionPrompt(input, fallbackText);
    if (!prompt) {
      return;
    }
    const questions = parseAskUserQuestions(input);

    const dedupeKey = toolUseId || `prompt:${prompt}`;
    if (this.emittedAskUserQuestionKeys.has(dedupeKey)) {
      return;
    }
    this.emittedAskUserQuestionKeys.add(dedupeKey);

    const inputRequestId = generateId();
    const approvalTraceId = createApprovalTraceId('ask_user_question');
    this.emit('status', 'waiting_for_input' as InstanceStatus);
    logger.info('[APPROVAL_TRACE] adapter_emit_ask_user_question', {
      approvalTraceId,
      instanceSessionId: this.sessionId,
      requestId: inputRequestId,
      toolUseId: toolUseId || null
    });

    this.emit('input_required', {
      id: inputRequestId,
      prompt,
      timestamp,
      metadata: {
        type: 'ask_user_question',
        tool_use_id: toolUseId,
        input,
        questions,
        approvalTraceId,
        traceStage: 'adapter:ask_user_question_emit'
      }
    });

    // Also mirror into system output so the user can always see what was asked.
    this.emit('output', {
      id: inputRequestId,
      timestamp,
      type: 'system',
      content: prompt,
      metadata: {
        requiresInput: true,
        askUserQuestion: true,
        approvalTraceId,
        traceStage: 'adapter:ask_user_question_output'
      }
    });
  }

  private rememberToolUse(
    toolUseId: string | undefined,
    toolName: string | undefined,
    input: unknown
  ): void {
    if (!toolUseId || !toolName) {
      return;
    }
    const normalizedInput =
      input && typeof input === 'object'
        ? (input as Record<string, unknown>)
        : {};
    emitClaudeSelfWakeup(this, toolName, toolUseId, normalizedInput);
    this.toolUseContexts.set(toolUseId, {
      name: toolName,
      input: sanitizeClaudeToolInput(toolName, normalizedInput)
    });
  }

  private emitAsyncWork(event: CliAsyncWorkEvent | null): void {
    if (event) this.emit('async_work', event);
  }

  private forgetToolUse(toolUseId: string | undefined): void {
    if (!toolUseId) {
      return;
    }
    this.toolUseContexts.delete(toolUseId);
  }

  private async primeCliVersion(): Promise<void> {
    // Detect only when the optional optimization is enabled. The default send
    // path never uses the flag, so an unconditional help probe would add a
    // blocking child process before every first message.
    if (this.spawnOptions.excludeDynamicSystemPromptSections) {
      await this.detectExcludeDynamicSupport();
    }
    if ((this.spawnOptions.excludeDynamicSystemPromptSections || (this.spawnOptions.resume && this.spawnOptions.systemPrompt)) && !resolveClaudeCliVersion(this.cachedCliStatus?.version)) await this.checkStatus().catch(() => undefined);
    if (this.spawnOptions.yoloMode || !this.spawnOptions.permissionHookPath) {
      return;
    }

    const status = await this.checkStatus();
    if (!status.available) {
      logger.warn('Unable to verify Claude CLI version before enabling defer permissions', {
        ...errorDiagnostic(status.error),
        sessionId: this.sessionId,
      });
    }
  }

  /** A jailed CLI must not refresh the shared login (claude-hardened-login). */
  private async prepareHardenedLogin(): Promise<void> {
    if (!this.isHardenedModeConfigured()) {
      this.handedInLogin = null;
      return;
    }
    const configDir = this.buildSpawnEnv()['CLAUDE_CONFIG_DIR'];
    const env = await prepareHardenedClaudeLoginEnv(configDir);
    this.handedInLogin = env ? { configDir, env } : null;
  }

  protected override hardenedSpawnEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
    const login = this.handedInLogin;
    return login && login.configDir === env['CLAUDE_CONFIG_DIR'] ? login.env : undefined;
  }

  private shouldUsePermissionHook(): boolean {
    if (this.spawnOptions.yoloMode || !this.spawnOptions.permissionHookPath) {
      return false;
    }
    return isVersionAtLeast(this.cachedCliStatus?.version, DEFER_MIN_VERSION);
  }

}
