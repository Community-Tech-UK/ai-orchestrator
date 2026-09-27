import type {
  CliMessage,
  CliResponse,
  CliToolCall,
  TurnInterruptCompletion,
} from './base-cli-adapter';
import { CodexAppServerNotificationAdapter } from './codex-app-server-notification-adapter';
import type {
  FileAttachment,
  ThinkingContent,
} from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import type {
  AppServerNotification,
  ThreadGoalStatus,
  TurnCaptureState,
  UserInput,
} from './codex/app-server-types';
import {
  getCommandAggregatedOutput,
  getCommandExitCode,
} from './codex/thread-item-accessors';
import {
  extractCodexAppServerError,
  formatCodexAppServerError,
  isCodexUsageLimitErrorInfo,
} from './codex/app-server-errors';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import { hasPendingBrowserApproval } from './codex/browser-approval-watchdog';
import { wrapCodexSystemInstructions } from './codex/codex-prompt-blocks';
import {
  createCodexTurnCaptureState,
  type CodexTurnCaptureCallbacks,
} from './codex/app-server-thread-runtime';
import { CodexAppServerRuntimeError, createCodexUsageLimitError } from './codex/app-server-runtime-errors';
import { codexLimitResetAt, parseCodexAccountRateLimitsRead } from './codex/account-rate-limits';
import { readChildRolloutUsage } from './codex/child-rollout-usage';
import { sendCodexOrchestrationResponse } from './codex/orchestration-response-send';
import { getLogger } from '../../logging/logger';
import type { InstanceStatus } from '../../../shared/types/instance.types';

const logger = getLogger('CodexCliAdapter');
const USAGE_LIMIT_RATE_LIMITS_TIMEOUT_MS = 3_000;
const THREAD_GOAL_RPC_TIMEOUT_MS = 5_000;

/** Executes app-server turns using the notification-routing layer. */
export abstract class CodexAppServerTurnAdapter extends CodexAppServerNotificationAdapter {
  private readonly childRolloutRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private childRolloutRetryEpoch = 0;
  /**
   * Fresh per user send. Minted in `appServerSendMessage`, the only user-send
   * entry, so recovery continuations and the input-cap retry keep it.
   */
  private contextOuterSendId: string | null = null;
  /** Settles after a Codex-started turn's output has been published; null when none runs. */
  private providerTurnDone: Promise<void> | null = null;
  /** Harness sends in flight; they own the busy/idle status while they run. */
  private pendingHarnessSends = 0;
  /** Last goal status Codex reported, keyed to the thread it was reported for. */
  private threadGoal: { threadId: string; status: ThreadGoalStatus | null } | null = null;

  /** Deliver an orchestration response after the resident turn releases its slot. */
  async sendOrchestrationResponse(message: string, onDelayed?: () => void): Promise<void> {
    return sendCodexOrchestrationResponse(message, {
      isAppServerMode: () => this.useAppServer,
      isReady: () => this.isSpawned && this.useAppServer && this.appServerRuntime.isRunning(),
      hasActiveTurn: () => this.appServerRuntime.hasActiveTurn(),
      isCompactionRunning: () => this.contextCostController.isCompactionRunning(),
      awaitCompactionSettled: () => this.contextCostController.awaitCompactionSettled(),
      sendInput: (content) => this.sendInput(content, undefined, { internalSource: 'orchestrator-response' }),
      onDelayed,
    });
  }

  /** Scopes ContextSafetyPolicy's per-send recovery ceiling to one user send. */
  getContextOuterSendId(): string | null {
    return this.contextOuterSendId;
  }

  protected override async sendInputImpl(
    message: string,
    attachments?: FileAttachment[],
    metadata?: CliMessage['metadata'],
  ): Promise<void> {
    this.pendingHarnessSends += 1;
    try {
      await super.sendInputImpl(message, attachments, metadata);
    } finally {
      this.pendingHarnessSends -= 1;
    }
  }

  protected override handleIdleAppServerNotification(notification: AppServerNotification): void {
    super.handleIdleAppServerNotification(notification);
    this.trackThreadGoal(notification);
    this.followProviderTurn(notification);
  }

  private trackThreadGoal(notification: AppServerNotification): void {
    const threadId = this.getAppServerThreadId();
    if (!threadId || notification.params['threadId'] !== threadId) return;
    if (notification.method === 'thread/goal/cleared') this.threadGoal = { threadId, status: null };
    if (notification.method !== 'thread/goal/updated') return;
    const status = (notification.params['goal'] as { status?: unknown } | undefined)?.status;
    this.threadGoal = { threadId, status: typeof status === 'string' ? status as ThreadGoalStatus : null };
  }

  /** The reported goal status for the current thread: undefined when never reported, null when cleared. */
  private knownGoalStatus(): ThreadGoalStatus | null | undefined {
    const goal = this.threadGoal;
    return goal && goal.threadId === this.getAppServerThreadId() ? goal.status : undefined;
  }

  /**
   * Stops Codex from restarting work by itself after the user stopped it: an
   * active thread goal would otherwise start a continuation turn as soon as the
   * interrupted turn ends. Resolves true when a goal was paused.
   */
  async stopProviderAutoContinuation(): Promise<boolean> {
    const client = this.getAppServerClient();
    const threadId = this.getAppServerThreadId();
    if (!this.useAppServer || !client || !threadId) return false;
    try {
      // A goal reported active is paused in one request, sent ahead of the
      // interrupt on the same connection, so Codex cannot start its next goal
      // turn in between. Only an unknown status (e.g. a resumed thread) is read first.
      const known = this.knownGoalStatus();
      if (known !== 'active') {
        if (known !== undefined) return false;
        const { goal } = await client.request('thread/goal/get', { threadId }, THREAD_GOAL_RPC_TIMEOUT_MS);
        if (goal?.status !== 'active') return false;
      }
      await client.request('thread/goal/set', { threadId, status: 'paused' }, THREAD_GOAL_RPC_TIMEOUT_MS);
      this.threadGoal = { threadId, status: 'paused' };
    } catch (error) {
      logger.warn('Could not pause the Codex thread goal after a stop', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    logger.info('Paused the Codex thread goal after a stop', { threadId });
    this.emit('output', {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Paused the Codex goal so it does not restart the work by itself. Send a message to continue.',
      metadata: { providerGoalPaused: true },
    });
    return true;
  }

  /** True when the thread has an active goal, so Codex resumes idle work by itself. */
  protected async isThreadGoalActive(): Promise<boolean> {
    const known = this.knownGoalStatus();
    if (known !== undefined) return known === 'active';
    const client = this.getAppServerClient();
    const threadId = this.getAppServerThreadId();
    if (!client || !threadId) return false;
    try {
      const { goal } = await client.request('thread/goal/get', { threadId }, THREAD_GOAL_RPC_TIMEOUT_MS);
      return goal?.status === 'active';
    } catch {
      return false;
    }
  }

  /** Whether a Codex-started turn is being followed right now. */
  protected hasProviderTurn(): boolean {
    return this.providerTurnDone !== null;
  }

  /**
   * Follows a root-thread turn Codex started without a Harness request (e.g. a
   * goal continuation). The Compact turn of a Harness compaction request is
   * excluded; the compaction lifecycle presents that one.
   */
  private followProviderTurn(notification: AppServerNotification): void {
    if (notification.method !== 'turn/started' || !this.useAppServer) return;
    const rootThreadId = this.getAppServerThreadId();
    if (!rootThreadId || notification.params['threadId'] !== rootThreadId) return;
    const turnId = (notification.params['turn'] as { id?: unknown } | undefined)?.id;
    if (typeof turnId !== 'string') return;
    if (this.appServerRuntime.hasActiveTurn() || this.contextCostController.isCompactTurnExpected()) return;
    const capture = this.appServerRuntime.captureProviderTurn(turnId, this.turnCaptureCallbacks(), notification);
    if (!capture) return;
    logger.info('Following a turn Codex started by itself', { threadId: rootThreadId, turnId });
    this.emit('status', 'busy' as InstanceStatus);
    const startedAtMs = Date.now();
    const done: Promise<void> = capture
      .then((state) => this.finishProviderTurn(state, rootThreadId, startedAtMs))
      .catch((error: unknown) => this.failProviderTurn(turnId, error))
      .finally(() => {
        if (this.providerTurnDone === done) this.providerTurnDone = null;
        // A terminated or exited adapter reports through its exit path, and a Harness send owns its own status.
        if (!this.isSpawned || !this.useAppServer || this.pendingHarnessSends > 0) return;
        const stillWorking = this.appServerRuntime.hasActiveTurn() || this.contextCostController.isCompactionRunning();
        this.emit('status', (stillWorking ? 'busy' : 'idle') as InstanceStatus);
      });
    this.providerTurnDone = done;
  }

  private async finishProviderTurn(state: TurnCaptureState, rootThreadId: string, startedAtMs: number): Promise<void> {
    const endedAtMs = Date.now();
    const turnId = state.turnId;
    this.usageAccounting.fallback(rootThreadId, state.finalTurn?.usage as Record<string, unknown> | undefined);
    if (turnId) await this.reconcileChildRollouts(rootThreadId, turnId, startedAtMs, endedAtMs);
    if (state.finalTurn?.status === 'interrupted' && !state.finalTurn.usage) {
      this.usageAccounting.estimateInterruptedOutput(rootThreadId, this.unreportedStreamedCharacters(state));
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
    if (turnId) this.scheduleChildRolloutRetry(rootThreadId, turnId, startedAtMs, endedAtMs);
    const status = state.finalTurn?.status;
    if (status === 'failed' || state.error) {
      this.flushPartialUsage();
      this.emitProviderTurnError(this.describeFailedTurn(state));
      return;
    }
    if (status === 'interrupted') {
      this.flushPartialUsage();
      return;
    }
    this.emitCompletedTurn(state);
  }

  private failProviderTurn(turnId: string, error: unknown): void {
    this.flushPartialUsage();
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('A turn Codex started by itself ended without completing', { turnId, error: message });
    // A closed transport is reported by the adapter exit path.
    if (error instanceof CodexAppServerRuntimeError && error.kind === 'transport-closed') return;
    this.emitProviderTurnError(message);
  }

  private emitProviderTurnError(message: string): void {
    this.emit('output', {
      id: generateId(), timestamp: Date.now(), type: 'error', content: `Codex error: ${message}`,
    });
  }

  private describeFailedTurn(state: TurnCaptureState): string {
    const details = state.finalTurn?.error !== undefined && state.finalTurn.error !== null
      ? extractCodexAppServerError({ error: state.finalTurn.error })
      : undefined;
    const fromTurn = details ? formatCodexAppServerError(details) : undefined;
    const captured = state.error instanceof Error
      ? state.error.message
      : (typeof state.error === 'string' ? state.error : undefined);
    return fromTurn ?? captured ?? 'Codex turn failed';
  }

  /**
   * Delivers a Harness send into the running Codex-started turn and waits for
   * that turn to finish, so the send resolves with its output published.
   */
  private async joinProviderTurn(
    input: UserInput[],
    developerInput?: string,
  ): Promise<{ joined: boolean; developerInjected: boolean }> {
    const done = this.providerTurnDone;
    if (!done) return { joined: false, developerInjected: false };
    const { delivered, developerInjected } = await this.appServerRuntime.steerProviderTurn(input, developerInput);
    if (delivered) await done;
    return { joined: delivered, developerInjected };
  }

  protected override async appServerSendMessage(
    message: string,
    attachments?: FileAttachment[],
    metadata?: CliMessage['metadata'],
  ): Promise<void> {
    this.contextOuterSendId = generateId();
    await super.appServerSendMessage(message, attachments, metadata);
  }

  protected override async appServerSendMessageInner(
    message: string,
    attachments?: FileAttachment[],
    costRecoveryCount = 0,
    metadata?: CliMessage['metadata'],
  ): Promise<void> {
    if (!this.getAppServerClient() || !this.getAppServerThreadId()) {
      throw new Error('App-server not initialized');
    }
    if (this.appServerRuntime.hasActiveTurn() && !this.hasProviderTurn()) throw new CodexAppServerRuntimeError({
      kind: 'request-rejected', message: 'Codex app-server runtime already has an active turn', recoverability: 'retry-thread',
    });
    const rootThreadId = this.getAppServerThreadId()!;
    const resumed = this.lastResumeAttemptResult?.confirmed === true
      && ['native', 'jsonl-scan', 'running-adopted'].includes(this.lastResumeAttemptResult.source);

    // App-server turns accept multimodal inputs. Keep supported images as
    // `localImage` items and only fall back to file references for everything
    // else so vision-capable Codex models still receive the original pixels.
    const preparedAttachments = attachments && attachments.length > 0
      ? await this.prepareAttachmentsForAppServer(message, attachments)
      : { input: [], text: message };
    let content = preparedAttachments.text;

    // Include system prompt on the very first turn only.
    if (!this.systemPromptSent && this.cliConfig.systemPrompt?.trim()) {
      const prompt = this.cliConfig.systemPrompt;
      content = wrapCodexSystemInstructions(prompt, content);
      this.systemPromptSent = true;
    }

    // Inject RTK awareness on the first turn when the feature is enabled.
    // Codex has no programmatic PreToolUse hook, so awareness-via-prompt is
    // the integration surface — keeps shell commands prefixed with `rtk`.
    if (!this.rtkAwarenessSent && this.cliConfig.rtkEnabled) {
      content = `${wrapRtkAwareness()}\n\n${content}`;
      this.rtkAwarenessSent = true;
    }

    // Start the turn and capture notifications. Harness-authored text
    // (`metadata.internalSource`, LT-657) goes in as a developer-role item so
    // Codex never records it as the user's message.
    const input: UserInput[] = [];
    const text = content.trim();
    const developerInput = text && typeof metadata?.['internalSource'] === 'string' ? text : undefined;
    if (text && !developerInput) {
      input.push({ type: 'text', text, text_elements: [] });
    }
    input.push(...preparedAttachments.input);

    if (input.length === 0 && !developerInput) {
      throw new Error('Cannot send empty app-server turn input');
    }

    let pendingDeveloperInput = developerInput;
    if (this.hasProviderTurn()) {
      const join = await this.joinProviderTurn(input, developerInput);
      if (join.joined) return;
      // The turn ended mid-join; its developer item is already in history.
      if (join.developerInjected) pendingDeveloperInput = undefined;
    }

    let turnState: TurnCaptureState;
    // Attachment preparation can yield; do not reset another in-flight turn's counters.
    if (this.appServerRuntime.hasActiveTurn()) throw new CodexAppServerRuntimeError({
      kind: 'request-rejected', message: 'Codex app-server runtime already has an active turn', recoverability: 'retry-thread',
    });
    this.hasTokenUsageNotification = false;
    this.usageAccounting.beginTurn(rootThreadId, resumed);
    const startedAtMs = Date.now();
    try {
      turnState = await this.captureTurn(input, metadata, pendingDeveloperInput);
    } catch (error) {
      this.flushPartialUsage();
      throw error;
    }
    const endedAtMs = Date.now();
    this.usageAccounting.fallback(rootThreadId, turnState.finalTurn?.usage as Record<string, unknown> | undefined);
    if (turnState.turnId) await this.reconcileChildRollouts(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
    if (turnState.finalTurn?.status === 'interrupted' && !turnState.finalTurn.usage) {
      this.usageAccounting.estimateInterruptedOutput(rootThreadId, this.unreportedStreamedCharacters(turnState));
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
    if (turnState.finalTurn?.status === 'failed' || turnState.finalTurn?.status === 'interrupted' || turnState.error) {
      this.flushPartialUsage();
    }

    if (await this.contextCostController.recoverAfterTurn({
      turnStatus: turnState.finalTurn?.status,
      recoveryCount: costRecoveryCount,
      // The same-thread continuation is Harness's text, not the user's (LT-657).
      continueTurn: (continuation, nextCount) => this.appServerSendMessageInner(
        continuation, undefined, nextCount, { ...metadata, internalSource: 'context-policy' },
      ),
      providerWillContinue: async () => this.hasProviderTurn() || await this.isThreadGoalActive(),
    })) {
      if (turnState.turnId) this.scheduleChildRolloutRetry(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
      return;
    }

    // Check for failed turns (e.g., context overflow, API errors).
    // Codex reports these as turn/completed with status: "failed".
    const turnStatus = turnState.finalTurn?.status;
    if (turnStatus === 'failed' || turnState.error) {
      if (turnState.turnId) this.scheduleChildRolloutRetry(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
      const finalTurnDetails = turnState.finalTurn?.error !== undefined && turnState.finalTurn.error !== null
        ? extractCodexAppServerError({ error: turnState.finalTurn.error })
        : undefined;
      const finalTurnError = finalTurnDetails ? formatCodexAppServerError(finalTurnDetails) : undefined;
      const capturedError = turnState.error instanceof Error
        ? turnState.error.message
        : (typeof turnState.error === 'string' ? turnState.error : undefined);
      const errorMsg = finalTurnError ?? capturedError ?? 'Codex turn failed';
      const usageLimit = isCodexUsageLimitErrorInfo(finalTurnDetails?.codexErrorInfo)
        || (turnState.error instanceof CodexAppServerRuntimeError && turnState.error.quota !== undefined);
      if (usageLimit) throw createCodexUsageLimitError(errorMsg, await this.readUsageLimitResetAt());
      throw new Error(errorMsg);
    }

    if (turnStatus === 'interrupted') {
      if (turnState.turnId) this.scheduleChildRolloutRetry(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
      return;
    }

    if (turnState.turnId) this.scheduleChildRolloutRetry(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
    this.emitCompletedTurn(turnState);
  }

  /** Publishes a completed turn's final message, usage, cost, and response. */
  private emitCompletedTurn(turnState: TurnCaptureState): void {
    // Emit the final response
    const responseContent = turnState.lastAgentMessage || '';
    const toolCalls = this.buildToolCallsFromTurnState(turnState);

    if (responseContent || toolCalls.length > 0) {
      const extracted = extractThinkingContent(responseContent, { headerStyle: false });

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
        id: turnState.finalAgentOutputId ?? generateId(),
        timestamp: Date.now(),
        type: 'assistant',
        content: extracted.response,
        metadata: {
          ...(turnState.turnId ? { turnId: turnState.turnId } : {}),
          ...(turnState.finalAgentOutputId ? {
            streaming: false,
            accumulatedContent: extracted.response,
            thinkingExtracted: true,
          } : {}),
        },
        thinking: allThinking.length > 0 ? allThinking : undefined,
        thinkingExtracted: turnState.finalAgentOutputId ? true : undefined,
      });
    }

    const usage = this.usageAccounting.take(this.cliConfig.model);
    this.cumulativeCostUsd += usage?.cost ?? 0;
    const contextWindow = this.resolveContextWindow();
    this.emit('context', {
      used: this.lastTurnTokens,
      total: contextWindow,
      percentage: contextWindow > 0 ? Math.min((this.lastTurnTokens / contextWindow) * 100, 100) : 0,
      cumulativeTokens: this.cumulativeTokensUsed,
      costEstimate: this.cumulativeCostUsd,
      ...(this.lastTurnTokens === 0 ? { isEstimated: true } : {}),
    });
    this.emit('cost', { costEstimate: this.cumulativeCostUsd });

    // Build and emit the complete response
    const response: CliResponse = {
      id: this.generateResponseId(),
      content: turnState.lastAgentMessage || '',
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      metadata: { codexUsage: {
        model: this.cliConfig.model ?? null,
        initializedServiceTier: this.effectiveServiceTier,
        requestedTurnServiceTier: this.cliConfig.fastMode ? 'priority' : null,
        costBasis: 'standard-api-equivalent',
      } },
    };
    this.completeResponse(response);
  }

  override async terminate(graceful = true): Promise<void> {
    this.childRolloutRetryEpoch++;
    for (const timer of this.childRolloutRetryTimers) clearTimeout(timer);
    this.childRolloutRetryTimers.clear();
    await super.terminate(graceful);
  }

  private scheduleChildRolloutRetry(
    rootThreadId: string,
    rootTurnId: string,
    startedAtMs: number,
    endedAtMs: number,
    attempt = 0,
  ): void {
    const delays = [250, 750, 2_000];
    const delay = delays[attempt];
    if (delay === undefined) return;
    const epoch = this.childRolloutRetryEpoch;
    const timer = setTimeout(() => {
      this.childRolloutRetryTimers.delete(timer);
      if (epoch !== this.childRolloutRetryEpoch) return;
      void this.reconcileChildRollouts(rootThreadId, rootTurnId, startedAtMs, endedAtMs)
        .then(() => {
          if (epoch !== this.childRolloutRetryEpoch) return;
          if (!this.appServerRuntime.hasActiveTurn()) this.flushPartialUsage();
        })
        .catch(() => { /* A transient rollout read can be retried at the next bounded attempt. */ })
        .finally(() => {
          if (epoch === this.childRolloutRetryEpoch) {
            this.scheduleChildRolloutRetry(rootThreadId, rootTurnId, startedAtMs, endedAtMs, attempt + 1);
          }
        });
    }, delay);
    timer.unref?.();
    this.childRolloutRetryTimers.add(timer);
  }

  protected async reconcileChildRollouts(rootThreadId: string, rootTurnId: string, startedAtMs: number, endedAtMs: number): Promise<void> {
    for (const { threadId, usage, baseline } of await readChildRolloutUsage(rootThreadId, rootTurnId, { startedAtMs, endedAtMs })) {
      if (baseline && !this.usageAccounting.hasThreadSnapshot(threadId)) this.usageAccounting.seed(threadId, baseline);
      this.usageAccounting.observe(threadId, usage, undefined, true);
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
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
    if (messageThreadId && messageThreadId !== state.threadId && this.usageAccounting.ownsThread(messageThreadId)
      && ['thread/tokenUsage/updated', 'turn/started', 'turn/completed'].includes(notification.method)) return true;
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
  private async captureTurn(
    input: UserInput[],
    metadata?: CliMessage['metadata'],
    developerInput?: string,
  ): Promise<TurnCaptureState> {
    this.ensureAppServerRuntimeAttached();
    const turnParams: Record<string, unknown> = {};
    if (this.cliConfig.outputSchema) turnParams['outputSchema'] = this.cliConfig.outputSchema;
    if (this.cliConfig.reasoningEffort) turnParams['effort'] = this.cliConfig.reasoningEffort;
    if (this.cliConfig.fastMode) turnParams['serviceTier'] = 'priority';

    return this.appServerRuntime.captureTurn({
      input,
      ...(developerInput ? { developerInput } : {}),
      turnParams,
      completeTurn: (state, turn) => this.completeTurn(state, turn),
      ...this.turnCaptureCallbacks(metadata),
    });
  }

  private turnCaptureCallbacks(metadata?: CliMessage['metadata']): CodexTurnCaptureCallbacks {
    return {
      createState: createCodexTurnCaptureState,
      belongsToTurn: (state, notification) => this.belongsToTurn(state, notification),
      handleNotification: (state, notification) => this.handleTurnNotification(state, notification),
      toInterruptCompletion: (state) => this.toTurnInterruptCompletion(state),
      resolveNotificationIdleTimeoutMs: (turnEstablished) => {
        const configured = this.resolveNotificationIdleTimeoutMs(turnEstablished);
        const activeTimeoutMs = metadata?.['continueWhileActiveOnTimeout'] === true
          && typeof metadata['activeTimeoutMs'] === 'number'
          ? metadata['activeTimeoutMs']
          : 0;
        return Math.max(configured, activeTimeoutMs);
      },
      hasPendingApproval: () => hasPendingBrowserApproval(this.cliConfig.browserGatewayInstanceId),
      onHeartbeat: () => this.emit('heartbeat'),
      onAbandonedTurn: () => this.contextDiagnostics?.completeTurn('unknown'),
    };
  }

  /**
   * On `usageLimitExceeded`, ask the live app-server for its windows so the
   * limit carries an authoritative reset time (soonest exhausted window, else
   * primary). Time-boxed; any failure falls back to parsing the message text.
   */
  private async readUsageLimitResetAt(): Promise<number | undefined> {
    const client = this.getAppServerClient();
    if (!client) return undefined;
    try {
      const response = await client.request('account/rateLimits/read', undefined, USAGE_LIMIT_RATE_LIMITS_TIMEOUT_MS);
      const read = parseCodexAccountRateLimitsRead(response);
      if (read.rateLimits) this.emit('account-rate-limits', read.rateLimits);
      const resetAt = codexLimitResetAt(read.rateLimits);
      return resetAt !== null && resetAt > Date.now() ? resetAt : undefined;
    } catch {
      return undefined;
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

  /** Test-facing compatibility wrapper around the runtime-owned state factory. */
  private createTurnCaptureState(threadId: string): TurnCaptureState {
    return createCodexTurnCaptureState(threadId);
  }

  /**
   * Converts TurnCaptureState command executions and file changes into CliToolCalls.
   */
  private buildToolCallsFromTurnState(state: TurnCaptureState): CliToolCall[] {
    const toolCalls: CliToolCall[] = [];

    for (const cmd of state.commandExecutions) {
      const exitCode = getCommandExitCode(cmd);
      toolCalls.push({
        id: cmd.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'command_execution',
        arguments: {
          command: cmd.command,
          exitCode,
          status: cmd.status,
        },
        result: getCommandAggregatedOutput(cmd) || undefined,
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
  protected abstract resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number;
}
