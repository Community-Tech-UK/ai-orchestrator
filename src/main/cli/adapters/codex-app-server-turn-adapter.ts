import type {
  CliMessage,
  AdapterInputDispatch,
  CliResponse,
} from './base-cli-adapter';
import { CodexAppServerNotificationAdapter } from './codex-app-server-notification-adapter';
import type { FileAttachment, InstanceStatus, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import type {
  AppServerNotification,
  ThreadGoalStatus,
  TurnCaptureState,
  UserInput,
} from './codex/app-server-types';
import { buildToolCallsFromTurnState, toTurnInterruptCompletion } from './codex/turn-result';
import { wrapRtkAwareness } from '../rtk/rtk-awareness';
import { hasPendingBrowserApproval } from './codex/browser-approval-watchdog';
import { wrapCodexSystemInstructions } from './codex/codex-prompt-blocks';
import {
  createCodexTurnCaptureState,
  type CodexTurnCaptureCallbacks,
} from './codex/app-server-thread-runtime';
import { CodexAppServerRuntimeError } from './codex/app-server-runtime-errors';
import { createCodexTurnFailure } from './codex/turn-failure';
import { codexLimitResetAt, parseCodexAccountRateLimitsRead } from './codex/account-rate-limits';
import { readChildRolloutUsage } from './codex/child-rollout-usage';
import { sendCodexOrchestrationResponse } from './codex/orchestration-response-send';
import { injectOrchestrationIntoRunningTurn } from './codex/orchestration-turn-injection';
import { getLogger } from '../../logging/logger';
import { errorDiagnostic } from '../../logging/source-diagnostics';
import { readCodexActiveGoal, readCodexContinuationOwnership } from './codex/native-continuation-ownership';
import { assertAdapterInputCurrent } from './adapter-input-dispatch';
import { buildCodexTurnInputDispatch } from './codex/turn-input-dispatch';
import { PendingCodexTurnNotifications, notificationTurnId } from './codex/pending-turn-notifications';
import { requiredSkillInputs, withRequiredSkillMentions } from './codex/codex-required-skills';

const logger = getLogger('CodexCliAdapter');
const USAGE_LIMIT_RATE_LIMITS_TIMEOUT_MS = 3_000;
const THREAD_GOAL_RPC_TIMEOUT_MS = 5_000;

/** Executes app-server turns using the notification-routing layer. */
export abstract class CodexAppServerTurnAdapter extends CodexAppServerNotificationAdapter {
  private readonly childRolloutRetryTimers = new Set<ReturnType<typeof setTimeout>>();
  private childRolloutRetryEpoch = 0;
  /** Per user send; recovery continuations and input-cap retries keep it. */
  private contextOuterSendId: string | null = null;
  /** Settles after a Codex-started turn's output has been published; null when none runs. */
  private providerTurnDone: Promise<void> | null = null;
  private harnessTurnPublishing = false;
  /** Wire-order events received after the next native turn starts, until capture can follow it. */
  private readonly pendingProviderNotifications = new PendingCodexTurnNotifications();
  /** Harness sends in flight; they own the busy/idle status while they run. */
  private pendingHarnessSends = 0;
  private terminating = false;
  /** Bounded replay protection; native turn ids are never reused. */
  private readonly finishedProviderTurns = new Set<string>();
  /** Last goal status Codex reported, keyed to the thread it was reported for. */
  private threadGoal: { threadId: string; status: ThreadGoalStatus | null } | null = null;

  /** Deliver an orchestration response into the running turn, or as a new turn once idle. */
  async sendOrchestrationResponse(message: string, onDelayed?: () => void): Promise<void> {
    return sendCodexOrchestrationResponse(message, {
      isAppServerMode: () => this.useAppServer,
      isReady: () => this.isSpawned && this.useAppServer && this.appServerRuntime.isRunning(),
      hasActiveTurn: () => this.appServerRuntime.hasActiveTurn(),
      isCompactionRunning: () => this.contextCostController.isCompactionRunning(),
      awaitCompactionSettled: () => this.contextCostController.awaitCompactionSettled(),
      injectIntoActiveTurn: (content) => injectOrchestrationIntoRunningTurn(content, this.appServerRuntime, (text) => this.sendOrchestrationResponse(text)),
      sendInput: (content) => this.sendInput(content, undefined, { internalSource: 'orchestrator-response' }),
      onDelayed,
    });
  }

  /** Scopes ContextSafetyPolicy's per-send recovery ceiling to one user send. */
  getContextOuterSendId(): string | null { return this.contextOuterSendId; }

  protected override async sendInputImpl(
    message: string,
    attachments?: FileAttachment[],
    metadata?: CliMessage['metadata'],
    dispatch?: AdapterInputDispatch,
  ): Promise<void> {
    this.pendingHarnessSends += 1;
    try {
      await super.sendInputImpl(message, attachments, metadata, dispatch);
    } finally {
      this.pendingHarnessSends -= 1;
    }
  }

  protected override handleIdleAppServerNotification(notification: AppServerNotification): void {
    this.trackThreadGoal(notification);
    if (notification.method === 'turn/started' && notification.params['threadId'] === this.getAppServerThreadId()
      && this.finishedProviderTurns.has(notificationTurnId(notification) as string)) return;
    const currentTurnId = this.appServerRuntime.getCurrentTurnId();
    const belongsToCurrentRoot = currentTurnId && notification.params['threadId'] === this.getAppServerThreadId()
      && notificationTurnId(notification) === currentTurnId;
    if (this.pendingProviderNotifications.length > 0 && !belongsToCurrentRoot) {
      this.pendingProviderNotifications.push(notification);
      return;
    }
    if (!this.followProviderTurn(notification)) super.handleIdleAppServerNotification(notification);
  }

  protected override handleIdleUsage(notification: AppServerNotification, flush = true): void {
    super.handleIdleUsage(notification, flush && !this.providerTurnDone && !this.harnessTurnPublishing);
  }

  private trackThreadGoal(notification: AppServerNotification): void {
    const threadId = this.getAppServerThreadId();
    if (!threadId || notification.params['threadId'] !== threadId) return;
    if (notification.method === 'thread/goal/cleared') this.threadGoal = { threadId, status: null };
    if (notification.method !== 'thread/goal/updated') return;
    const status = (notification.params['goal'] as { status?: unknown } | undefined)?.status;
    logger.info('Codex thread goal changed', { status: ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(String(status)) ? status : 'unknown' });
    this.threadGoal = { threadId, status: typeof status === 'string' ? status as ThreadGoalStatus : null };
  }

  /** The reported goal status for the current thread: undefined when never reported, null when cleared. */
  private knownGoalStatus(): ThreadGoalStatus | null | undefined {
    const goal = this.threadGoal;
    return goal && goal.threadId === this.getAppServerThreadId() ? goal.status : undefined;
  }

  /** Pauses an active goal before interrupting so Codex cannot restart it; true when paused. */
  async stopProviderAutoContinuation(): Promise<boolean> {
    const client = this.getAppServerClient();
    const threadId = this.getAppServerThreadId();
    if (!this.useAppServer || !client || !threadId) return false;
    try {
      // Pause before interrupting; read only an unknown goal (e.g. a resumed thread).
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
        ...errorDiagnostic(error),
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

  /** Native turns and unreadable goals exclude a competing Harness prompt. */
  async hasProviderAutoContinuation(): Promise<boolean> {
    if (!this.useAppServer) return false;
    if (this.hasProviderTurn() || this.appServerRuntime.hasActiveTurn()) return true;
    return readCodexContinuationOwnership(this.knownGoalStatus(), this.getAppServerClient(), this.getAppServerThreadId());
  }
  /** Recheck notification-backed ownership at the synchronous dispatch boundary. */
  hasPendingProviderAutoContinuation(): boolean {
    return this.useAppServer && (this.hasProviderTurn() || this.appServerRuntime.hasActiveTurn() || this.knownGoalStatus() === 'active');
  }
  /** Native context recovery's goal check; outer recovery uses the fail-closed owner check above. */
  protected async isThreadGoalActive(): Promise<boolean> {
    return readCodexActiveGoal(this.knownGoalStatus(), this.getAppServerClient(), this.getAppServerThreadId());
  }
  /** Whether a Codex-started turn is being followed right now. */
  protected hasProviderTurn(): boolean { return this.providerTurnDone !== null; }

  protected hasPendingProviderWork(): boolean {
    return this.hasProviderTurn() || this.pendingProviderNotifications.length > 0;
  }

  /** Follow a root-thread turn Codex started itself. Compact turns stay with compaction. */
  private followProviderTurn(notification: AppServerNotification, buffered: AppServerNotification[] = []): boolean {
    if (notification.method === 'turn/completed' && notification.params['threadId'] === this.getAppServerThreadId()) {
      this.rememberFinishedTurn(notificationTurnId(notification));
    }
    if (notification.method !== 'turn/started' || !this.useAppServer || !this.isSpawned || this.terminating) return false;
    const rootThreadId = this.getAppServerThreadId();
    if (!rootThreadId || notification.params['threadId'] !== rootThreadId) return false;
    const turnId = (notification.params['turn'] as { id?: unknown } | undefined)?.id;
    if (typeof turnId !== 'string') return false;
    if (this.finishedProviderTurns.has(turnId)) return false;
    if (this.contextCostController.isCompactTurnExpected()) return false;
    const active = this.appServerRuntime.getActiveTurnState();
    const activeTurnId = this.appServerRuntime.getCurrentTurnId();
    if (active && activeTurnId !== null && activeTurnId !== turnId && !active.completed) {
      this.rememberFinishedTurn(activeTurnId);
      this.completeTurn(active, null);
    }
    if (this.appServerRuntime.hasActiveTurn() || this.providerTurnDone || this.harnessTurnPublishing) {
      // Capturing and publishing both own the prior turn's output and usage.
      const currentTurnId = this.appServerRuntime.getCurrentTurnId();
      // The current capture adopts its first turn/started, including before turn/start replies.
      if (!this.appServerRuntime.hasActiveTurn() || (currentTurnId !== null && currentTurnId !== turnId)) {
        this.pendingProviderNotifications.push(notification);
        this.emit('status', 'busy' as InstanceStatus);
        return true;
      }
      return false;
    }
    const capture = this.appServerRuntime.captureProviderTurn(turnId, {
      ...this.turnCaptureCallbacks(),
      onBufferedNotification: event => {
        this.pendingProviderNotifications.release(event);
        if (event.method === 'turn/completed' && event.params['threadId'] === rootThreadId) {
          this.rememberFinishedTurn(notificationTurnId(event));
        }
        super.handleIdleAppServerNotification(event);
      },
    }, [notification, ...buffered]);
    if (!capture) return false;
    // Another queued root start proves this replayed turn ended, even if its terminal was lost.
    const replayed = this.appServerRuntime.getActiveTurnState();
    if (this.pendingProviderNotifications.length > 0 && replayed && !replayed.completed) {
      this.rememberFinishedTurn(turnId);
      this.completeTurn(replayed, null);
    }
    logger.info('Following a turn Codex started by itself', { threadId: rootThreadId, turnId });
    this.emit('status', 'busy' as InstanceStatus);
    const startedAtMs = Date.now();
    const epoch = this.childRolloutRetryEpoch;
    const current = () => epoch === this.childRolloutRetryEpoch && rootThreadId === this.getAppServerThreadId();
    const done: Promise<void> = capture
      .then((state) => current() ? this.finishProviderTurn(state, rootThreadId, startedAtMs) : undefined)
      .catch((error: unknown) => { if (current()) this.failProviderTurn(turnId, error); })
      .finally(() => {
        if (this.providerTurnDone === done) this.providerTurnDone = null;
        if (!current()) return;
        if (this.followPendingProviderTurn()) return;
        // A terminated or exited adapter reports through its exit path, and a Harness send owns its own status.
        if (!this.isSpawned || !this.useAppServer || this.pendingHarnessSends > 0) return;
        const stillWorking = this.appServerRuntime.hasActiveTurn() || this.contextCostController.isCompactionRunning();
        this.emit('status', (stillWorking ? 'busy' : 'idle') as InstanceStatus);
      });
    this.providerTurnDone = done;
    return true;
  }

  private followPendingProviderTurn(): boolean {
    while (!this.providerTurnDone && !this.harnessTurnPublishing && !this.appServerRuntime.hasActiveTurn()
      && this.pendingProviderNotifications.length > 0) {
      const [first, ...rest] = this.pendingProviderNotifications.takeTurn();
      if (this.followProviderTurn(first, rest)) return true;
      for (const event of [first, ...rest]) {
        this.pendingProviderNotifications.release(event);
        super.handleIdleAppServerNotification(event);
      }
    }
    return false;
  }

  private rememberFinishedTurn(turnId: unknown): void {
    if (typeof turnId !== 'string') return;
    this.finishedProviderTurns.add(turnId);
    const oldest = this.finishedProviderTurns.values().next();
    if (this.finishedProviderTurns.size > 64 && !oldest.done) this.finishedProviderTurns.delete(oldest.value);
  }

  private async finishProviderTurn(state: TurnCaptureState, rootThreadId: string, startedAtMs: number): Promise<void> {
    const epoch = this.childRolloutRetryEpoch;
    const endedAtMs = Date.now();
    const turnId = state.turnId;
    this.rememberFinishedTurn(turnId);
    this.settleRootTurnUsage(rootThreadId, state.turnId, state.finalTurn?.usage);
    if (turnId) await this.reconcileChildRollouts(rootThreadId, turnId, startedAtMs, endedAtMs);
    if (epoch !== this.childRolloutRetryEpoch || rootThreadId !== this.getAppServerThreadId()) return;
    if (state.finalTurn?.status === 'interrupted' && !state.finalTurn.usage) {
      this.usageAccounting.estimateInterruptedOutput(rootThreadId, this.unreportedStreamedCharacters(state));
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
    if (turnId) this.scheduleChildRolloutRetry(rootThreadId, turnId, startedAtMs, endedAtMs);
    const status = state.finalTurn?.status;
    if (status === 'failed' || state.error) {
      this.flushPartialUsage();
      this.emitProviderTurnError(createCodexTurnFailure(state));
      return;
    }
    if (status === 'interrupted') {
      this.flushPartialUsage();
      this.reportProviderHarnessStop(state);
      return;
    }
    this.emitCompletedTurn(state);
  }

  private failProviderTurn(turnId: string, error: unknown): void {
    this.flushPartialUsage();
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('A turn Codex started by itself ended without completing', { turnId, ...errorDiagnostic(error) });
    // A closed transport is reported by the adapter exit path.
    if (error instanceof CodexAppServerRuntimeError && error.kind === 'transport-closed') return;
    this.emitProviderTurnError(error instanceof Error ? error : new Error(message));
  }

  private emitProviderTurnError(error: Error): void {
    this.emit('output', {
      id: generateId(), timestamp: Date.now(), type: 'error', content: `Codex error: ${error.message}`,
    });
    this.emit('turn_error', Object.assign(error, { willRetry: false }));
  }

  /** Joins the native turn and resolves once its output has been published. */
  private async joinProviderTurn(
    input: UserInput[],
    developerInput?: string,
    dispatch?: AdapterInputDispatch,
    onInputAccepted?: () => void,
  ): Promise<{ joined: boolean; developerInjected: boolean }> {
    const done = this.providerTurnDone;
    if (!done) return { joined: false, developerInjected: false };
    const { delivered, developerInjected } = await this.appServerRuntime.steerProviderTurn(input, developerInput, dispatch, onInputAccepted);
    await done;
    return { joined: delivered, developerInjected };
  }

  protected override async appServerSendMessage(
    message: string,
    attachments?: FileAttachment[],
    metadata?: CliMessage['metadata'],
    dispatch?: AdapterInputDispatch,
  ): Promise<void> {
    this.contextOuterSendId = generateId();
    this.harnessTurnPublishing = true;
    try {
      await super.appServerSendMessage(message, attachments, metadata, dispatch);
    } finally {
      this.harnessTurnPublishing = false;
      this.followPendingProviderTurn();
    }
  }

  protected override async appServerSendMessageInner(
    message: string,
    attachments?: FileAttachment[],
    costRecoveryCount = 0,
    metadata?: CliMessage['metadata'],
    dispatch?: AdapterInputDispatch,
  ): Promise<void> {
    if (!this.getAppServerClient() || !this.getAppServerThreadId()) {
      throw new Error('App-server not initialized');
    }
    assertAdapterInputCurrent(dispatch, this.hasPendingProviderAutoContinuation());
    if (this.appServerRuntime.hasActiveTurn() && !this.hasProviderTurn()) throw new CodexAppServerRuntimeError({
      kind: 'request-rejected', message: 'Codex app-server runtime already has an active turn', recoverability: 'retry-thread',
    });
    const client = this.getAppServerClient()!;
    const rootThreadId = this.getAppServerThreadId()!;
    const resumed = this.lastResumeAttemptResult?.confirmed === true
      && ['native', 'jsonl-scan', 'running-adopted'].includes(this.lastResumeAttemptResult.source);

    // Preserve supported images as localImage; reference other attachments as files.
    const preparedAttachments = attachments && attachments.length > 0
      ? await this.prepareAttachmentsForAppServer(message, attachments)
      : { input: [], text: message };
    let content = preparedAttachments.text;

    const prompt = this.cliConfig.systemPrompt;
    const includeSystemPrompt = !this.systemPromptSent && !!prompt?.trim();
    if (includeSystemPrompt && prompt) {
      content = wrapCodexSystemInstructions(prompt, content);
    }

    // Inject RTK awareness on the first turn; Harness installs no Codex RTK hook yet.
    const includeRtkAwareness = !this.rtkAwarenessSent && this.cliConfig.rtkEnabled;
    if (includeRtkAwareness) {
      content = `${wrapRtkAwareness()}\n\n${content}`;
    }
    const onInputAccepted = () => {
      // A late acknowledgment belongs to the connection/thread that received it.
      if (this.getAppServerClient() !== client || this.getAppServerThreadId() !== rootThreadId) return;
      if (includeSystemPrompt) this.systemPromptSent = true;
      if (includeRtkAwareness) this.rtkAwarenessSent = true;
    };

    // Harness-authored text uses a developer item, never a user message (LT-657).
    const input: UserInput[] = [];
    const text = content.trim();
    const developerInput = text && typeof metadata?.['internalSource'] === 'string' ? text : undefined;
    if (developerInput) input.push(...requiredSkillInputs(this.cliConfig, text));
    else if (text) input.push({ type: 'text', text: withRequiredSkillMentions(this.cliConfig, text), text_elements: [] });
    input.push(...preparedAttachments.input);

    if (input.length === 0 && !developerInput) {
      throw new Error('Cannot send empty app-server turn input');
    }

    let pendingDeveloperInput = developerInput;
    assertAdapterInputCurrent(dispatch, this.hasPendingProviderAutoContinuation());
    const publishing = this.harnessTurnPublishing;
    try {
      while (this.hasProviderTurn() || this.pendingProviderNotifications.length > 0) {
        this.harnessTurnPublishing = false;
        this.followPendingProviderTurn();
        const join = await this.joinProviderTurn(input, pendingDeveloperInput, dispatch, onInputAccepted);
        if (join.joined) return;
        if (join.developerInjected) pendingDeveloperInput = undefined;
      }
    } finally { this.harnessTurnPublishing = publishing; }

    let turnState: TurnCaptureState;
    // Attachment preparation can yield; do not reset another in-flight turn's counters.
    if (this.appServerRuntime.hasActiveTurn()) throw new CodexAppServerRuntimeError({
      kind: 'request-rejected', message: 'Codex app-server runtime already has an active turn', recoverability: 'retry-thread',
    });
    this.hasTokenUsageNotification = false;
    this.usageAccounting.beginTurn(rootThreadId, resumed);
    const startedAtMs = Date.now();
    try {
      turnState = await this.captureTurn(input, metadata, pendingDeveloperInput, dispatch, onInputAccepted);
    } catch (error) {
      this.flushPartialUsage();
      throw error;
    }
    const endedAtMs = Date.now();
    this.settleRootTurnUsage(rootThreadId, turnState.turnId, turnState.finalTurn?.usage);
    if (turnState.turnId) await this.reconcileChildRollouts(rootThreadId, turnState.turnId, startedAtMs, endedAtMs);
    if (turnState.finalTurn?.status === 'interrupted' && !turnState.finalTurn.usage) {
      this.usageAccounting.estimateInterruptedOutput(rootThreadId, this.unreportedStreamedCharacters(turnState));
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
    if (turnState.finalTurn?.status === 'failed' || turnState.finalTurn?.status === 'interrupted' || turnState.error) {
      this.flushPartialUsage();
      this.throwIfStoppedByHarness(turnState, () => { if (turnState.turnId) this.scheduleChildRolloutRetry(rootThreadId, turnState.turnId, startedAtMs, endedAtMs); });
    }

    if (await this.contextCostController.recoverAfterTurn({
      turnStatus: turnState.finalTurn?.status,
      recoveryCount: costRecoveryCount,
      // The same-thread continuation is Harness's text, not the user's (LT-657).
      continueTurn: (continuation, nextCount) => this.appServerSendMessageInner(
        continuation, undefined, nextCount, { ...metadata, internalSource: 'context-policy' },
        dispatch,
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
      const error = createCodexTurnFailure(turnState);
      if (error instanceof CodexAppServerRuntimeError && error.quota) {
        throw createCodexTurnFailure(turnState, await this.readUsageLimitResetAt());
      }
      throw error;
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
    const responseContent = turnState.lastAgentMessage || '';
    const toolCalls = buildToolCallsFromTurnState(turnState);

    if (responseContent || toolCalls.length > 0) {
      const extracted = extractThinkingContent(responseContent, { headerStyle: false });

      // Merge native reasoning items with thinking extracted from the final text.
      const allThinking: ThinkingContent[] = [];

      // Native reasoning summaries are already deduplicated.
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
      metadata: { ...(turnState.turnId ? { codexTurn: { threadId: turnState.threadId, turnId: turnState.turnId } } : {}), codexUsage: {
        model: this.cliConfig.model ?? null,
        initializedServiceTier: this.effectiveServiceTier,
        requestedTurnServiceTier: this.cliConfig.fastMode ? 'priority' : null,
        costBasis: 'standard-api-equivalent',
      } },
    };
    this.completeResponse(response);
  }

  override async terminate(graceful = true): Promise<void> {
    this.terminating = true;
    this.providerTurnDone = null;
    this.finishedProviderTurns.clear();
    this.pendingProviderNotifications.clear();
    this.childRolloutRetryEpoch++;
    for (const timer of this.childRolloutRetryTimers) clearTimeout(timer);
    this.childRolloutRetryTimers.clear();
    try { await super.terminate(graceful); }
    finally { this.terminating = false; }
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
          if (!this.appServerRuntime.hasActiveTurn() && !this.providerTurnDone && !this.harnessTurnPublishing) this.flushPartialUsage();
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
    const epoch = this.childRolloutRetryEpoch;
    const receipts = await readChildRolloutUsage(rootThreadId, rootTurnId, { startedAtMs, endedAtMs });
    if (epoch !== this.childRolloutRetryEpoch || rootThreadId !== this.getAppServerThreadId()) return;
    if (!this.usageAccounting.ownsThread(rootThreadId)) return;
    for (const { threadId, usage, baseline } of receipts) {
      if (baseline && !this.usageAccounting.hasThreadSnapshot(threadId)) this.usageAccounting.seed(threadId, baseline);
      this.turnCeiling.measure(true, () => this.usageAccounting.observe(threadId, usage, undefined, true), 'late', rootTurnId);
    }
    this.cumulativeTokensUsed = this.usageAccounting.cumulativeTokens;
    this.turnCeiling.finishTurn(rootTurnId);
  }

  /** Matches root and owned child notifications to their captured native turn. */
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

  private async captureTurn(
    input: UserInput[],
    metadata?: CliMessage['metadata'],
    developerInput?: string,
    dispatch?: AdapterInputDispatch,
    onInputAccepted?: () => void,
  ): Promise<TurnCaptureState> {
    this.ensureAppServerRuntimeAttached();
    return this.appServerRuntime.captureTurn({
      onNativeTurnAcquired: (id) => this.followProviderTurn({ method: 'turn/started', params: { threadId: this.getAppServerThreadId(), turn: { id } } }),
      ...buildCodexTurnInputDispatch(this.cliConfig, dispatch,
        () => this.hasPendingProviderAutoContinuation(), () => this.hasProviderTurn() || this.knownGoalStatus() === 'active'),
      input,
      onInputAccepted,
      ...(developerInput ? { developerInput } : {}),
      completeTurn: (state, turn) => this.completeTurn(state, turn),
      ...this.turnCaptureCallbacks(metadata),
    });
  }

  private turnCaptureCallbacks(metadata?: CliMessage['metadata']): CodexTurnCaptureCallbacks {
    return {
      shouldDeferNotification: notification => this.pendingProviderNotifications.has(notification),
      createState: createCodexTurnCaptureState,
      belongsToTurn: (state, notification) => this.belongsToTurn(state, notification),
      handleNotification: (state, notification) => this.handleTurnNotification(state, notification),
      toInterruptCompletion: toTurnInterruptCompletion,
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

  /** Reads the soonest exhausted (else primary) reset window; time-boxed, else parse the error text. */
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

  /** Test-facing compatibility wrapper around the runtime-owned state factory. */
  private createTurnCaptureState(threadId: string): TurnCaptureState {
    return createCodexTurnCaptureState(threadId);
  }

  protected abstract resolveNotificationIdleTimeoutMs(turnEstablished: boolean): number;
}
