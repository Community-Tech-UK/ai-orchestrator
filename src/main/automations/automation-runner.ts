import { getLogger } from '../logging/logger';
import { getWorkAdmission } from '../work-admission/work-admission';
import { isVisibleOutputMessage } from '../../shared/types/tool-outcome';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import type {
  Automation,
  AutomationAction,
  AutomationFireOutcome,
  AutomationRun,
  AutomationRunStatus,
  ClaimedAutomationRun,
  FireAutomationOptions,
} from '../../shared/types/automation.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { InstanceEventEnvelope } from '@contracts/types/instance-events';
import { AutomationStore } from './automation-store';
import { getAutomationEvents } from './automation-events';
import { ThreadWakeupRunner } from './thread-wakeup-runner';
import { SessionRevivalService } from '../session/session-revival-service';
import { emitAutomationRunStarted } from './automation-run-started';
import { dispatchAutomationSystemAction } from './automation-system-action-dispatch';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
} from './automation-retry';
import {
  writeFullOutput,
  type RunTracking,
} from './automation-runner-helpers';
import {
  automationFromSnapshot,
  automationShellFromRunSnapshot,
  FAILURE_STATUSES,
  WAIT_STATUSES,
} from './automation-runner-snapshots';
import type {
  RetrySchedulerCallback,
  ThreadWakeupRunnerFactory,
} from './automation-runner-types';
import { renderWebhookPromptTemplate } from './webhook-prompt-template';
import { classifyFinalOutputProviderLimit } from '../cli/final-output-provider-limit';
import {
  readAutomationModelDefaults,
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
  type AutomationSpawnTarget,
} from './automation-model-defaults';
import { AutomationLoopRunDispatcher, defaultLoopRunExists, recoverLoopLinkedRuns } from './automation-loop-run';
import { getNotificationService } from '../notifications/notification-service';
import { checkContainedExecutionGate } from './automation-execution-profile-gate';
import {
  handleTerminalRun as handleTerminalRunImpl,
  type AutomationTerminalRunHost,
} from './automation-runner-terminal';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { revealHiddenAutomationSession, stampHiddenAutomationOutcome } from './automation-hidden-outcome';
import { defaultAutomationNetworkGate, type AutomationNetworkGate } from './automation-network-gate';
import { automationAccountPreferences, type AutomationAccountPreferencesResolver } from './automation-account-rules';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { AutomationPauseStartup } from './automation-pause-startup';
import { isAutomaticStartupCancelled, type AutomaticStartup } from '../work-admission/automatic-startup';

const logger = getLogger('AutomationRunner');

export type { RetrySchedulerCallback } from './automation-runner-types';

export interface AutomationFireOptions extends FireAutomationOptions {
  /**
   * Ephemeral, authenticated webhook data. It is rendered into a redacted
   * per-run snapshot and is never written to the automation definition.
   */
  webhookPayload?: Record<string, unknown>;
}

export class AutomationRunner {
  private instanceManager: InstanceManager | null = null;
  private threadWakeupRunner: ThreadWakeupRunner | null = null;
  private readonly trackingByInstance = new Map<string, RunTracking>();
  private readonly instanceByRun = new Map<string, string>();
  private initialized = false;
  private promotingPending = false;
  private readonly pauseStartup = new AutomationPauseStartup();
  private retryScheduler: RetrySchedulerCallback | null = null;
  /** WS5: lazy — only loop-action automations pay for the loop-engine binding. */
  private loopRunDispatcher: AutomationLoopRunDispatcher | null = null;

  constructor(
    private readonly store: AutomationStore,
    private readonly events = getAutomationEvents(),
    private readonly now = () => Date.now(),
    private readonly threadWakeupRunnerFactory: ThreadWakeupRunnerFactory = (
      manager,
      automationStore,
      currentTime,
    ) => new ThreadWakeupRunner(
      manager,
      new SessionRevivalService(manager),
      automationStore,
      currentTime,
    ),
    private readonly maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
    private readonly baseRetryDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    private readonly automationModelDefaults: () => AutomationModelDefaults = readAutomationModelDefaults,
    private readonly isProviderExcluded: (provider: string) => boolean = isProviderExcludedFromAutomation,
    private readonly networkGate: AutomationNetworkGate = defaultAutomationNetworkGate,
    private readonly accountPreferencesFor: AutomationAccountPreferencesResolver = automationAccountPreferences,
  ) {}

  /**
   * Register the callback the runner will invoke when it needs to schedule a
   * retry.  Should be called by the scheduler immediately after construction.
   */
  setRetryScheduler(cb: RetrySchedulerCallback): void {
    this.retryScheduler = cb;
  }

  initialize(instanceManager: InstanceManager): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.instanceManager = instanceManager;
    this.threadWakeupRunner = this.threadWakeupRunnerFactory(instanceManager, this.store, this.now);
    const admission = getWorkAdmission();
    admission.registerCounter('automation-run', () => this.store.listActiveRuns().filter(run => run.status === 'running' && !run.configSnapshot?.action.forceNodeId).length);
    admission.on('admission-changed', () => {
      if (!admission.check('consult', { remote: true }).allowed) {
        for (const runId of this.instanceByRun.keys()) this.pauseRunForGlobalPause(runId);
      }
      void this.promotePendingIfAny().catch(error => logger.error('Promoting held automation failed', error instanceof Error ? error : undefined));
    });

    instanceManager.on('provider:normalized-event', (envelope: ProviderRuntimeEventEnvelope) => {
      this.handleProviderEvent(envelope);
    });
    instanceManager.on('instance:event', (envelope: InstanceEventEnvelope) => {
      this.handleInstanceEvent(envelope);
    });
    instanceManager.on('instance:removed', (instanceId: string) => {
      this.handleInstanceRemoved(instanceId);
    });

    const pausedRuns = GlobalPauseService.peek()?.getState().entries
      .filter((entry) => entry.kind === 'automation-run' && !['void', 'resumed', 'failed'].includes(entry.state))
      .map((entry) => entry.targetId) ?? [];
    for (const runId of pausedRuns) this.pauseStartup.pause(runId);
    const failed = this.store.failRunningRuns('App restarted before automation run completed', this.now(), pausedRuns);
    for (const run of failed) {
      this.events.emitRunChanged({ automationId: run.automationId, run });
      this.events.emitRunTerminal({ automationId: run.automationId, runId: run.id, status: 'failed' });
      if (this.isOneTimeRun(run)) {
        this.emitAutomationState(run.automationId);
        this.events.emitScheduleDeactivated({ automationId: run.automationId });
      }
    }

    // WS5: loop-linked running runs survive a restart — see recoverLoopLinkedRuns.
    recoverLoopLinkedRuns({
      runs: this.store.listRunningLoopLinkedRuns(),
      dispatcher: () => this.requireLoopRunDispatcher(),
      loopRunExists: defaultLoopRunExists,
      store: this.store,
      now: () => this.now(),
      onTerminal: (run, options) => this.handleTerminalRun(run, options),
    });
  }

  async fire(automationId: string, options: AutomationFireOptions): Promise<AutomationFireOutcome> {
    const manager = this.requireInstanceManager();
    const fireTime = options.scheduledAt ?? this.now();
    const automation = await this.store.get(automationId);
    const promptOverride = options.trigger === 'webhook' && options.webhookPayload && automation
      ? renderWebhookPromptTemplate(automation.action.prompt, options.webhookPayload).content
      : undefined;
    const preflightSkipReason = automation
      ? this.automaticProviderExclusionReason(automation.action, automation.destination.kind)
      : undefined;
    const decision = this.store.decideAndInsertRun(
      automation,
      options.trigger,
      fireTime,
      this.now(),
      {
        idempotencyKey: options.idempotencyKey,
        triggerSource: options.triggerSource,
        deliveryMode: options.deliveryMode,
        maxAttempts: this.maxRetryAttempts,
        attempt: 1,
        promptOverride,
        admissionHeld: !getWorkAdmission().check('automation-run', { remote: Boolean(automation?.action.forceNodeId) }).allowed,
        ...(preflightSkipReason ? { preflightSkipReason } : {}),
      },
    );

    if (decision.kind === 'missing') {
      this.events.emitOrphanedFire({ automationId });
      return { status: 'skipped', reason: decision.reason };
    }

    if (decision.kind === 'skipped') {
      if (decision.run) {
        this.events.emitRunChanged({ automationId: decision.run.automationId, run: decision.run });
      }
      return { status: 'skipped', run: decision.run, reason: decision.reason };
    }

    if (decision.kind === 'queued') {
      this.events.emitRunChanged({ automationId: decision.run.automationId, run: decision.run });
      return { status: 'queued', run: decision.run };
    }

    const run = decision.run;
    this.events.emitRunChanged({ automationId: run.automationId, run });
    emitAutomationRunStarted(run);
    await this.networkGate(run, this.store, () => this.dispatchRun({
      run,
      automation: automation as Automation,
      snapshot: run.configSnapshot!,
    }, manager));
    return { status: 'started', run };
  }

  async promotePendingIfAny(automationId?: string): Promise<void> {
    const manager = this.requireInstanceManager();
    // Only the global hold applies before we know the candidate's computer.
    if (this.promotingPending || !getWorkAdmission().check('timed-wakeup', { remote: true }).allowed) return;
    this.promotingPending = true;
    let claimed: ClaimedAutomationRun | null;
    try { claimed = this.store.claimNextPending(automationId, this.now(), run => getWorkAdmission().check('automation-run', { remote: Boolean(run.configSnapshot?.action.forceNodeId) }).allowed); }
    finally { this.promotingPending = false; }
    if (!claimed) {
      return;
    }
    this.events.emitRunChanged({ automationId: claimed.run.automationId, run: claimed.run });
    await this.networkGate(claimed.run, this.store, () => this.dispatchRun(claimed, manager));
  }

  untrackInstances(instanceIds: string[]): void {
    for (const instanceId of instanceIds) {
      const tracking = this.trackingByInstance.get(instanceId);
      if (tracking) {
        this.instanceByRun.delete(tracking.runId);
      }
      this.trackingByInstance.delete(instanceId);
      // The automation was deleted mid-run: no outcome will ever be recorded.
      revealHiddenAutomationSession(this.instanceManager, instanceId);
    }
  }

  /** Keep the durable run running while its provider is interrupted for a restart. */
  pauseRunForGlobalPause(runId: string): void {
    this.pauseStartup.pause(runId);
    const instanceId = this.instanceByRun.get(runId);
    if (instanceId) this.trackingByInstance.delete(instanceId);
    this.instanceByRun.delete(runId);
  }

  resumeRunForGlobalPause(runId: string, instanceId: string): void {
    this.pauseStartup.resume(runId);
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running') throw new Error('Scheduled job is no longer waiting to resume');
    if (this.instanceByRun.get(runId) !== instanceId) {
      this.trackInstance(instanceId, run);
      const attached = this.store.attachInstance(runId, instanceId, this.now());
      if (attached) this.events.emitRunChanged({ automationId: attached.automationId, run: attached });
    }
  }

  cancelRunForGlobalPause(runId: string, reason: string): void {
    if (this.store.getRun(runId)?.status !== 'running') return;
    this.pauseRunForGlobalPause(runId);
    const run = this.store.terminalizeRun(runId, 'cancelled', reason, undefined, this.now());
    if (run) this.handleTerminalRun(run, { retryable: false });
  }

  trackLoopRunForGlobalPause(runId: string, loopRunId: string): void {
    this.pauseStartup.resume(runId);
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running') throw new Error('Scheduled loop is no longer waiting to resume');
    this.requireLoopRunDispatcher().track(loopRunId, runId, run.automationId);
  }

  async resumePendingRunForGlobalPause(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running' || !run.configSnapshot) throw new Error('Scheduled job is no longer waiting to resume');
    this.pauseStartup.resume(runId);
    await this.dispatchRun({ run, snapshot: run.configSnapshot, automation: automationShellFromRunSnapshot(run) }, this.requireInstanceManager());
  }

  private dispatchRun(claimed: ClaimedAutomationRun, manager: InstanceManager): Promise<void> {
    const current = this.store.getRun?.(claimed.run.id);
    if (this.instanceByRun.has(claimed.run.id) || current?.loopRunId || (current && current.status !== 'running')) return Promise.resolve();
    const receipt = { threadDispatched: false };
    return this.pauseStartup.run(claimed.run.id, startup => this.dispatchRunOnce(claimed, manager, startup, receipt), () => {
      this.pauseRunForGlobalPause(claimed.run.id);
      if (!receipt.threadDispatched) this.store.attachInstance(claimed.run.id, null, this.now());
    });
  }

  private async dispatchRunOnce(claimed: ClaimedAutomationRun, manager: InstanceManager, startup: AutomaticStartup, receipt: { threadDispatched: boolean }): Promise<void> {
    const context = { remote: Boolean(claimed.snapshot.action.forceNodeId) };
    if (!getWorkAdmission().check('timed-wakeup', context).allowed) {
      getWorkAdmission().defer(`automation-dispatch:${claimed.run.id}`, 'timed-wakeup', async () => {
        if (this.store.getRun(claimed.run.id)?.status === 'running') await this.dispatchRun(claimed, manager);
      }, context);
      return;
    }
    if (claimed.run.attempt > 1) {
      this.events.emitRunChanged({ automationId: claimed.run.automationId, run: claimed.run });
      emitAutomationRunStarted(claimed.run);
    }
    const systemRun = await this.dispatchSystemActionIfHandled(claimed);
    if (systemRun) {
      this.handleTerminalRun(systemRun);
      return;
    }

    startup.signal.throwIfAborted();
    // WS-C7: contained only enforces on a fresh one-shot instance spawn — refuse thread/loop shapes rather than silently ignore the profile.
    if (this.refuseUnsupportedContainedShape(claimed.snapshot, claimed.run.id)) {
      return;
    }

    if (claimed.snapshot.destination.kind === 'thread') {
      const terminal = await this.requireThreadWakeupRunner().fireThreadWakeup({
        run: claimed.run,
        automation: automationFromSnapshot(claimed.automation, claimed.snapshot),
        destination: claimed.snapshot.destination,
        startup,
        onProviderDispatch: () => { receipt.threadDispatched = true; },
      });
      this.handleTerminalRun(terminal);
      return;
    }

    if (this.refuseExcludedAutomaticProvider(claimed.snapshot.action, claimed.run.id)) return;

    // WS5: loop actions spawn an autonomous loop instead of a one-shot
    // instance. The dispatcher terminalizes the run when the loop ends.
    if (claimed.snapshot.action.loop) {
      await this.requireLoopRunDispatcher().dispatch(claimed, startup);
      return;
    }

    try {
      const spawnTarget = this.resolveSpawnTargetOrRefuse(claimed.snapshot.action, claimed.run.id);
      if (!spawnTarget) {
        return;
      }
      // James's never-use and use-last account lists apply to automation sessions too.
      const accountPreferences = await this.accountPreferencesFor(spawnTarget, claimed.snapshot.action.forceNodeId);
      startup.signal.throwIfAborted();
      const contained = claimed.snapshot.action.executionProfile === 'contained';
      const instance = await manager.createInstance({
        // The automation name is operator-facing and already specific. Keep it
        // authoritative so a shared prompt preamble cannot make concurrent
        // automation sessions look identical in the narrow project rail.
        displayName: claimed.run.attempt > 1 ? `${claimed.snapshot.name} (retry ${claimed.run.attempt})` : claimed.snapshot.name,
        isRenamed: true,
        workingDirectory: claimed.snapshot.action.workingDirectory,
        initialPrompt: claimed.snapshot.action.prompt,
        attachments: claimed.snapshot.action.attachments,
        // WS-C7: contained forces the CLI's sandbox read-only via yoloMode=false.
        yoloMode: contained ? false : claimed.snapshot.action.yoloMode,
        agentId: claimed.snapshot.action.agentId,
        ...spawnTarget,
        ...(accountPreferences ? { accountPreferences } : {}),
        forceNodeId: claimed.snapshot.action.forceNodeId,
        reasoningEffort: claimed.snapshot.action.reasoningEffort,
        ...(contained ? { containedExecution: true } : {}),
        // Durable provenance so the rail can mark this session as
        // automation-born with a clock indicator. Survives archive into the
        // history entry independently of its display title.
        metadata: {
          spendPurpose: 'automation',
          automationId: claimed.run.automationId,
          automationRunId: claimed.run.id,
          // Snapshotted at fire time so the rail never has to join back to the
          // automation store, and archived threads keep behaving correctly after
          // the automation is edited or deleted.
          ...(claimed.snapshot.hidden === true ? { automationHidden: true } : {}),
        },
      });

      startup.register(instance, () => manager.terminateInstance(instance.id, false));
      this.trackInstance(instance.id, claimed.run);
      const attachedRun = this.store.attachInstance(claimed.run.id, instance.id, this.now());
      if (attachedRun) {
        this.events.emitRunChanged({ automationId: attachedRun.automationId, run: attachedRun });
      }

      this.reconcileInstanceState(instance);
      const settled = (error?: unknown): void => {
        if ((startup.signal.aborted || isAutomaticStartupCancelled(error)) && !startup.wasDispatched(instance.id)) {
          const current = this.store.getRun(claimed.run.id);
          if (current?.status === 'running' && current.instanceId === instance.id) {
            this.pauseRunForGlobalPause(claimed.run.id);
            this.store.attachInstance(claimed.run.id, null, this.now());
          }
          return;
        }
        if (error && !isAutomaticStartupCancelled(error)) this.failTrackedInstance(instance.id,
          `Automation dispatch failed: ${error instanceof Error ? error.message : String(error)}`);
      };
      void instance.readyPromise?.then(() => settled(), settled);
    } catch (error) {
      if (startup.signal.aborted) throw error;
      const failed = this.store.terminalizeRun(
        claimed.run.id,
        'failed',
        error instanceof Error ? error.message : String(error),
        undefined,
        this.now(),
      );
      if (failed) {
        this.handleTerminalRun(failed);
      }
    }
  }

  private trackInstance(instanceId: string, run: AutomationRun): void {
    this.trackingByInstance.set(instanceId, {
      runId: run.id,
      automationId: run.automationId,
      seenAssistantOutput: false,
      outputChunks: [],
    });
    this.instanceByRun.set(run.id, instanceId);
  }

  private handleProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    const tracking = this.trackingByInstance.get(envelope.instanceId);
    if (!tracking) {
      return;
    }

    switch (envelope.event.kind) {
      case 'output':
        tracking.outputChunks.push({
          kind: envelope.event.messageType ?? 'output',
          content: envelope.event.content,
          timestamp: Date.now(),
        });
        if (envelope.event.messageType === 'assistant' && envelope.event.content.trim().length > 0) {
          tracking.seenAssistantOutput = true;
          tracking.lastAssistantOutput = envelope.event.content;
        }
        break;
      case 'complete':
        if (tracking.seenAssistantOutput) {
          this.completeTrackedInstance(envelope.instanceId, 'succeeded');
        }
        break;
      case 'error':
        if (!envelope.event.recoverable) {
          this.failTrackedInstance(envelope.instanceId, envelope.event.message);
        }
        break;
      case 'exit':
        if (envelope.event.code !== 0) {
          this.failTrackedInstance(
            envelope.instanceId,
            `Instance exited with ${envelope.event.signal ? `signal ${envelope.event.signal}` : `code ${envelope.event.code ?? 'unknown'}`}`,
          );
        }
        break;
      default:
        break;
    }
  }

  private handleInstanceEvent(envelope: InstanceEventEnvelope): void {
    const tracking = this.trackingByInstance.get(envelope.instanceId);
    if (!tracking) {
      return;
    }

    const event = envelope.event;
    if (event.kind === 'removed') {
      this.failTrackedInstance(envelope.instanceId, 'Automation instance was removed');
      return;
    }

    if (event.kind !== 'status_changed') {
      return;
    }

    if (FAILURE_STATUSES.has(event.status)) {
      this.failTrackedInstance(envelope.instanceId, `Instance entered ${event.status}`);
      return;
    }

    if (WAIT_STATUSES.has(event.status)) {
      // A run that parks awaiting human approval/input is a deterministic
      // "needs a human" outcome, not a transient error — retrying just spawns
      // an identical session that walks to the same gate and re-parks. Mark it
      // non-retryable so the run fails once without duplicating sessions.
      this.failTrackedInstance(
        envelope.instanceId,
        event.status === 'waiting_for_permission'
          ? 'Automation requires unattended permission approval'
          : 'Automation requires unattended user input',
        { retryable: false },
      );
      return;
    }

    if (event.status === 'idle' && tracking.seenAssistantOutput) {
      this.completeTrackedInstance(envelope.instanceId, 'succeeded');
    }
  }

  private handleInstanceRemoved(instanceId: string): void {
    this.failTrackedInstance(instanceId, 'Automation instance was removed');
  }

  private async dispatchSystemActionIfHandled(
    claimed: ClaimedAutomationRun,
  ): Promise<AutomationRun | null> {
    return dispatchAutomationSystemAction(claimed, { store: this.store, now: () => this.now() });
  }

  /** WS-C7: contained has no enforcement path for a thread wakeup or a loop action — refuse rather than silently ignore the profile. Returns true when refused. */
  private refuseUnsupportedContainedShape(snapshot: ClaimedAutomationRun['snapshot'], runId: string): boolean {
    if (snapshot.action.executionProfile !== 'contained') {
      return false;
    }
    if (snapshot.destination.kind !== 'thread' && !snapshot.action.loop) {
      return false;
    }
    const reason = 'Contained runs only support a fresh one-shot instance today — thread-wakeup and loop actions cannot be sandboxed, so the run is refused instead of running unsandboxed.';
    const failed = this.store.terminalizeRun(runId, 'failed', reason, undefined, this.now());
    if (failed) {
      this.handleTerminalRun(failed, { retryable: false });
    }
    return true;
  }

  /** WS-C7: resolves + enforces the `contained` gate together so they can never diverge; null = refused (terminalized), do not spawn. */
  private resolveSpawnTargetOrRefuse(action: AutomationAction, runId: string): AutomationSpawnTarget | null {
    const spawnTarget = resolveAutomationSpawnTarget(action, this.automationModelDefaults());
    const gate = checkContainedExecutionGate(action.executionProfile, spawnTarget.provider);
    if (gate.ok) {
      return spawnTarget;
    }
    logger.warn('Automation run refused by contained-execution gate', { runId, reason: gate.reason });
    const failed = this.store.terminalizeRun(runId, 'failed', gate.reason, undefined, this.now());
    if (failed) {
      this.handleTerminalRun(failed, { retryable: false }); // deterministic refusal — never retry
    }
    return null;
  }

  private automaticProviderExclusionReason(
    action: AutomationAction,
    destinationKind: ClaimedAutomationRun['snapshot']['destination']['kind'] = 'newInstance',
  ): string | undefined {
    if (destinationKind !== 'newInstance' || action.systemAction) return undefined;
    if (action.provider && action.provider !== 'auto') return undefined;
    const resolved = resolveAutomationSpawnTarget(action, this.automationModelDefaults()).provider;
    if (!resolved || resolved === 'auto' || !this.isProviderExcluded(resolved)) return undefined;
    return `Resolved provider ${resolved} is excluded from automation`;
  }

  private refuseExcludedAutomaticProvider(action: AutomationAction, runId: string): boolean {
    const reason = this.automaticProviderExclusionReason(action);
    if (!reason) return false;
    const skipped = this.store.terminalizeRun(runId, 'skipped', reason, undefined, this.now());
    if (skipped) this.handleTerminalRun(skipped, { retryable: false });
    return true;
  }

  private requireLoopRunDispatcher(): AutomationLoopRunDispatcher {
    if (!this.loopRunDispatcher) {
      this.loopRunDispatcher = new AutomationLoopRunDispatcher({
        store: this.store,
        now: () => this.now(),
        onTerminal: (run, options) => this.handleTerminalRun(run, options),
      });
    }
    return this.loopRunDispatcher;
  }

  private reconcileInstanceState(instance: Instance): void {
    const tracking = this.trackingByInstance.get(instance.id);
    if (!tracking) {
      return;
    }

    const assistant = [...instance.outputBuffer].reverse().find((message) =>
      message.type === 'assistant' && message.content.trim().length > 0
    );
    if (assistant) {
      tracking.seenAssistantOutput = true;
      tracking.lastAssistantOutput = assistant.content;
    }
    // LT-196: miner-only records are not automation output.
    tracking.outputChunks.push(...instance.outputBuffer
      .filter(isVisibleOutputMessage)
      .slice(-20).map((message) => ({
      kind: message.type,
      content: message.content,
      timestamp: message.timestamp,
    })));

    if (FAILURE_STATUSES.has(instance.status)) {
      this.failTrackedInstance(instance.id, `Instance entered ${instance.status}`);
      return;
    }

    if (WAIT_STATUSES.has(instance.status)) {
      // See handleInstanceEvent: parking for human approval/input is not a
      // transient failure, so it must not trigger the retry loop.
      this.failTrackedInstance(
        instance.id,
        instance.status === 'waiting_for_permission'
          ? 'Automation requires unattended permission approval'
          : 'Automation requires unattended user input',
        { retryable: false },
      );
      return;
    }

    if (instance.status === 'idle' && tracking.seenAssistantOutput) {
      this.completeTrackedInstance(instance.id, 'succeeded');
    }
  }

  private completeTrackedInstance(
    instanceId: string,
    reportedStatus: Exclude<AutomationRunStatus, 'pending' | 'running'>,
    reportedError?: string,
    options?: { retryable?: boolean },
  ): void {
    const tracking = this.trackingByInstance.get(instanceId);
    if (!tracking) {
      return;
    }
    // A CLI that stops on a provider limit exits cleanly with the notice as its final message.
    const providerLimitError = reportedStatus === 'succeeded' ? classifyFinalOutputProviderLimit(tracking.lastAssistantOutput) : null;
    const status = providerLimitError ? 'failed' : reportedStatus;
    const error = providerLimitError ?? reportedError;

    this.trackingByInstance.delete(instanceId);
    this.instanceByRun.delete(tracking.runId);

    stampHiddenAutomationOutcome(this.instanceManager, instanceId, status);

    const outputFullRef = writeFullOutput(tracking);
    const run = this.store.terminalizeRun(
      tracking.runId,
      status,
      error,
      tracking.lastAssistantOutput ? tracking.lastAssistantOutput.slice(0, 4000) : undefined,
      { now: this.now(), outputFullRef },
    );
    if (!run) {
      return;
    }

    this.handleTerminalRun(run, options);
  }

  private failTrackedInstance(
    instanceId: string,
    reason: string,
    options?: { retryable?: boolean },
  ): void {
    this.completeTrackedInstance(instanceId, 'failed', reason, options);
  }

  private isOneTimeRun(run: AutomationRun): boolean {
    return run.configSnapshot?.schedule.type === 'oneTime';
  }

  private emitAutomationState(automationId: string): void {
    this.store.get(automationId).then((automation) => {
      if (!automation) return; // deleted concurrently — a 'deleted' event already covers it
      this.events.emitChanged({ automation, automationId, type: 'updated' });
    }).catch((error) => {
      logger.warn('Failed to publish automation state after run terminalized', {
        automationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private requireInstanceManager(): InstanceManager {
    if (!this.instanceManager) {
      throw new Error('AutomationRunner has not been initialized');
    }
    return this.instanceManager;
  }

  private requireThreadWakeupRunner(): ThreadWakeupRunner {
    if (!this.threadWakeupRunner) {
      throw new Error('AutomationRunner thread wakeup runner has not been initialized');
    }
    return this.threadWakeupRunner;
  }

  private handleTerminalRun(run: AutomationRun, options?: { retryable?: boolean }): void {
    handleTerminalRunImpl(this as unknown as AutomationTerminalRunHost, run, options);
  }

  /**
   * Record a give-up outcome for a run whose last retry attempt was abandoned
   * due to a concurrency-policy skip.  This keeps the consecutive-failure streak
   * accurate even when a retry is skipped for non-error reasons.
   *
   * Called from AutomationScheduler.onRetryTimer when concurrencyPolicy=skip
   * and the retry timer fires but a run is still active.
   */
  /**
   * WS5 breaker: an auto-disabled automation is an operator-actionable event —
   * raise a deduped notification (best-effort; never disrupt run bookkeeping).
   */
  private notifyAutoDisabled(automationId: string, consecutiveFailures?: number, reason?: string): void {
    try {
      getNotificationService().notify({
        kind: 'automation-breaker',
        title: 'Automation auto-disabled',
        body: `Disabled after ${consecutiveFailures ?? 'repeated'} consecutive failures`
          + `${reason ? ` (last: ${reason.slice(0, 200)})` : ''}. Re-enable it from the Automations page.`,
        urgency: 'critical',
        fingerprintFields: { automationId },
      });
    } catch {
      // Notification failure must never affect run bookkeeping.
    }
  }

  recordGiveUpOutcome(originalRun: AutomationRun): void {
    const outcome = this.store.recordRunOutcome(
      originalRun.automationId,
      'failed',
      originalRun.error ?? 'Retry skipped due to concurrency policy (skip)',
      this.now(),
    );
    if (outcome.autoDisabled) {
      logger.warn('Automation auto-disabled after repeated failures (give-up via concurrency skip)', {
        automationId: originalRun.automationId,
        consecutiveFailures: outcome.automation?.consecutiveFailures,
      });
      this.notifyAutoDisabled(originalRun.automationId, outcome.automation?.consecutiveFailures, originalRun.error ?? undefined);
      this.emitAutomationState(originalRun.automationId);
      this.events.emitScheduleDeactivated({ automationId: originalRun.automationId });
    }
  }

  /**
   * Dispatch a retry run that was created by the scheduler when the retry
   * timer fires.  Called from `AutomationScheduler.onRetryTimer`.
   */
  async dispatchRetryRun(retryRun: AutomationRun): Promise<void> {
    if (!retryRun.configSnapshot) {
      const failed = this.store.terminalizeRun(retryRun.id, 'failed', 'Retry run has no config snapshot', undefined, this.now());
      if (failed) this.handleTerminalRun(failed);
      return;
    }
    await this.dispatchRun({ run: retryRun, snapshot: retryRun.configSnapshot, automation: automationShellFromRunSnapshot(retryRun) }, this.requireInstanceManager());
  }
}
