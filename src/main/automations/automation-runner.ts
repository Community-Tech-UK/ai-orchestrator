import { refuseAutomationAuthorityDispatch } from './automation-execution-authority';
import { AutomationEarlyEvents, authorizeCompletion, isReceiptCurrent } from './automation-completion-receipts';
import { automationInvocations } from './automation-invocation-context';
import { markAutomationDelivery } from './automation-delivery-audit';
import { AutomationDispatchDeadline } from './automation-dispatch-deadline';
import { completedAutomationTurnError, reconcileAutomationInstance } from './automation-runner-reconcile';
import { providerLimitParkedRunError } from './automation-run-provider-limit';
import { RESTART_INTERRUPTION } from './automation-restart-retry';
import { AutomationRunLimits } from './automation-run-limits';
import type { AutomationResult } from '@contracts/schemas/automation';
import { harnessStopDetailsOf } from '../../shared/utils/harness-stop';
import { getLogger } from '../logging/logger';
import { getWorkAdmission } from '../work-admission/work-admission';
import type { InstanceManager } from '../instance/instance-manager';
import { getInstanceProviderLimitHandler, type ProviderLimitParkedEvent } from '../instance/instance-provider-limit-handler';
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
import { monitorAssistantOutput, writeFullOutput, type RunTracking } from './automation-runner-helpers';
import {
  automationFromSnapshot,
  automationShellFromRunSnapshot,
  FAILURE_STATUSES,
} from './automation-runner-snapshots';
import type {
  RetrySchedulerCallback,
  ThreadWakeupRunnerFactory,
} from './automation-runner-types';
import { renderWebhookPromptTemplate } from './webhook-prompt-template';
import {
  readAutomationModelDefaults,
  resolveAutomationSpawnTarget,
  type AutomationModelDefaults,
  type AutomationSpawnTarget,
} from './automation-model-defaults';
import { AutomationLoopRunDispatcher, defaultLoopRunExists, recoverLoopLinkedRuns } from './automation-loop-run';
import { checkContainedExecutionGate } from './automation-execution-profile-gate';
import {
  handleTerminalRun as handleTerminalRunImpl,
  notifyAutomationDisabled,
  type AutomationTerminalRunHost,
} from './automation-runner-terminal';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { revealHiddenAutomationSession, stampHiddenAutomationOutcome } from './automation-hidden-outcome';
import { defaultAutomationNetworkGate, type AutomationNetworkGate } from './automation-network-gate';
import { runAutomationPreCheckGate, type AutomationPreCheckGate } from './automation-pre-check-gate';
import { appendQuietReplyContract, isQuietReply, stripQuietSentinel } from './automation-run-quiet';
import { getAutomationCheckStore } from './automation-check-store';
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
  private readonly earlyEvents = new AutomationEarlyEvents();
  private initialized = false;
  private limits: AutomationRunLimits | null = null;
  private dispatchDeadline: AutomationDispatchDeadline | null = null;
  private promotingPending = false;
  private readonly pauseStartup = new AutomationPauseStartup(id => this.reportStopFailure(id));
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
    private readonly preCheckGate: AutomationPreCheckGate = runAutomationPreCheckGate,
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
    this.dispatchDeadline = new AutomationDispatchDeadline(this.now, (run, reason) => {
      if (this.store.getRun(run.id)?.status !== 'running') return;
      this.pauseStartup.cancel(run.id);
      const failed = this.store.terminalizeRun(run.id, 'failed', reason, undefined, this.now());
      if (failed) this.handleTerminalRun(failed, { retryable: false });
    });
    this.limits = new AutomationRunLimits(instanceManager, this.now, (id, reason) => this.failTrackedInstance(id, reason, { retryable: false }),
      (runId, instanceId, source, tokens) => this.store.addProcessedUsage(runId, instanceId, source, tokens), id => this.reportStopFailure(id), id => this.finishCompletedTurn(id));
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
    instanceManager.on('instance:provider-limit-parked', (parked: ProviderLimitParkedEvent) => this.endRunHeldOnLimit(parked));
    // A Claude held call ends the run only once a person is shown it: a saved rule or the reviewer may answer it first.
    instanceManager.on('instance:input-required', (ask: { instanceId: string; metadata?: Record<string, unknown> }) => {
      if (ask.metadata?.['type'] === 'deferred_permission') this.failTrackedInstance(ask.instanceId, 'Automation requires unattended permission approval', { retryable: false });
    });

    const pausedRuns = GlobalPauseService.peek()?.getState().entries
      .filter((entry) => entry.kind === 'automation-run' && !['void', 'resumed', 'failed'].includes(entry.state))
      .map((entry) => entry.targetId) ?? [];
    for (const runId of pausedRuns) this.pauseStartup.pause(runId);
    const failed = this.store.failRunningRuns(RESTART_INTERRUPTION, this.now(), pausedRuns);
    for (const run of failed) {
      if (run.configSnapshot?.action.preCheck) getAutomationCheckStore().clearPending(run.id);
      this.events.emitRunChanged({ automationId: run.automationId, run });
      this.events.emitRunTerminal({ automationId: run.automationId, runId: run.id, status: 'failed' });
      if (this.isOneTimeRun(run)) {
        this.emitAutomationState(run.automationId);
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
    const preflightSkipReason = this.hasStoppingRun(automationId) ? 'Previous scheduled job could not be stopped. Stop its sessions before running it again.' : automation
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
    this.dispatchDeadline?.arm(run);
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
    try { claimed = this.store.claimNextPending(automationId, this.now(), run => (run.attempt > 1 || !this.hasStoppingRun(run.automationId)) && getWorkAdmission().check('automation-run', { remote: Boolean(run.configSnapshot?.action.forceNodeId) }).allowed); }
    finally { this.promotingPending = false; }
    if (!claimed) {
      return;
    }
    this.events.emitRunChanged({ automationId: claimed.run.automationId, run: claimed.run });
    if (this.refuseRetryWhileStopping(claimed.run) || this.dispatchDeadline?.expireIfElapsed(claimed.run)) return;
    this.dispatchDeadline?.arm(claimed.run);
    await this.networkGate(claimed.run, this.store, () => this.dispatchRun(claimed, manager));
  }

  untrackInstances(instanceIds: string[]): void {
    for (const instanceId of instanceIds) {
      const tracking = this.trackingByInstance.get(instanceId);
      if (tracking) {
        this.instanceByRun.delete(tracking.runId);
      }
      this.trackingByInstance.delete(instanceId);
      this.limits?.clear(instanceId);
      // The automation was deleted mid-run: no outcome will ever be recorded.
      revealHiddenAutomationSession(this.instanceManager, instanceId);
    }
  }

  /** Keep the durable run running while its provider is interrupted for a restart. */
  pauseRunForGlobalPause(runId: string): void {
    this.pauseStartup.pause(runId);
    this.store.setRunPaused(runId, true, this.now());
    this.dispatchDeadline?.clear(runId);
    const instanceId = this.instanceByRun.get(runId);
    if (instanceId) { this.trackingByInstance.delete(instanceId); this.limits?.clear(instanceId); }
    this.instanceByRun.delete(runId);
  }

  resumeRunForGlobalPause(runId: string, instanceId: string): void {
    this.pauseStartup.resume(runId);
    this.store.setRunPaused(runId, false, this.now());
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
    this.store.setRunPaused(runId, false, this.now());
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running') throw new Error('Scheduled loop is no longer waiting to resume');
    this.requireLoopRunDispatcher().track(loopRunId, run);
  }

  async resumePendingRunForGlobalPause(runId: string): Promise<void> {
    this.store.setRunPaused(runId, false, this.now());
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running' || !run.configSnapshot) throw new Error('Scheduled job is no longer waiting to resume');
    this.pauseStartup.resume(runId);
    this.dispatchDeadline?.arm(run);
    await this.dispatchRun({ run, snapshot: run.configSnapshot, automation: automationShellFromRunSnapshot(run) }, this.requireInstanceManager());
  }

  private dispatchRun(claimed: ClaimedAutomationRun, manager: InstanceManager): Promise<void> {
    const current = this.store.getRun?.(claimed.run.id);
    if (this.instanceByRun.has(claimed.run.id) || current?.loopRunId || (current && current.status !== 'running')) return Promise.resolve();
    if (this.refuseRetryWhileStopping(claimed.run) || this.dispatchDeadline?.expireIfElapsed(claimed.run)) return Promise.resolve();
    const receipt = { threadDispatched: false };
    return this.pauseStartup.run(claimed.run.id, startup => this.dispatchRunOnce(claimed, manager, startup, receipt), () => {
      this.pauseRunForGlobalPause(claimed.run.id);
      if (!receipt.threadDispatched) this.store.attachInstance(claimed.run.id, null, this.now());
    }, () => !this.dispatchDeadline?.expireIfElapsed(claimed.run));
  }

  private async dispatchRunOnce(claimed: ClaimedAutomationRun, manager: InstanceManager, startup: AutomaticStartup, receipt: { threadDispatched: boolean }): Promise<void> {
    if (this.refuseRetryWhileStopping(claimed.run) || this.dispatchDeadline?.expireIfElapsed(claimed.run)) return;
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
    if (refuseAutomationAuthorityDispatch(claimed, this.store, this.now(), (run, options) => this.handleTerminalRun(run, options))) return;
    const systemRun = await this.dispatchSystemActionIfHandled(claimed);
    startup.signal.throwIfAborted();
    if (systemRun) {
      this.handleTerminalRun(systemRun);
      return;
    }
    if (this.refuseRetryWhileStopping(claimed.run) || this.dispatchDeadline?.expireIfElapsed(claimed.run)) return;

    // WS-C7: contained only enforces on a fresh one-shot instance spawn — refuse thread/loop shapes rather than silently ignore the profile.
    if (this.refuseUnsupportedContainedShape(claimed.snapshot, claimed.run.id)) {
      return;
    }

    if (await this.preCheckGate(claimed, {
      store: this.store,
      now: () => this.now(),
      handleTerminalRun: (run, options) => this.handleTerminalRun(run, options),
    })) return;

    if (claimed.snapshot.destination.kind === 'thread') {
      const terminal = await this.requireThreadWakeupRunner().fireThreadWakeup({
        run: claimed.run,
        automation: automationFromSnapshot(claimed.automation, claimed.snapshot),
        destination: claimed.snapshot.destination,
        startup,
        onProviderDispatch: () => { receipt.threadDispatched = true; },
      });
      startup.signal.throwIfAborted();
      this.handleTerminalRun(terminal);
      return;
    }

    if (this.refuseExcludedAutomaticProvider(claimed.snapshot.action, claimed.run.id)) return;

    // WS5: loop actions spawn an autonomous loop instead of a one-shot
    // instance. The dispatcher terminalizes the run when the loop ends.
    if (claimed.snapshot.action.loop) {
      await this.requireLoopRunDispatcher().dispatch(claimed, startup);
      this.dispatchDeadline?.clear(claimed.run.id);
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
      if (this.refuseRetryWhileStopping(claimed.run) || this.dispatchDeadline?.expireIfElapsed(claimed.run)) return;
      const contained = claimed.snapshot.action.executionProfile === 'contained';
      const instance = await manager.createInstance({
        // Keep the job's own name authoritative in the project rail.
        displayName: claimed.run.attempt > 1 ? `${claimed.snapshot.name} (retry ${claimed.run.attempt})` : claimed.snapshot.name,
        isRenamed: true,
        workingDirectory: claimed.snapshot.action.workingDirectory,
        initialPrompt: appendQuietReplyContract(claimed.snapshot.action.prompt, claimed.run.trigger),
        attachments: claimed.snapshot.action.attachments,
        // WS-C7: contained forces the CLI's sandbox read-only via yoloMode=false.
        yoloMode: contained ? false : claimed.snapshot.action.yoloMode,
        automationAuthority: claimed.snapshot.action.executionAuthority,
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

      if (this.dispatchDeadline?.expireIfElapsed(claimed.run)) return this.limits?.stopLateInstance(instance.id, claimed.run);
      startup.register(instance, () => manager.terminateInstance(instance.id, false));
      this.trackInstance(instance.id, claimed.run);
      const attachedRun = this.store.attachInstance(claimed.run.id, instance.id, this.now());
      if (attachedRun) {
        this.events.emitRunChanged({ automationId: attachedRun.automationId, run: attachedRun });
      }

      this.reconcileInstanceState(instance);
      this.earlyEvents.drain(claimed.run.id, instance.id, event => this.handleProviderEvent(event));
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
    this.dispatchDeadline?.clear(run.id);
    this.trackingByInstance.set(instanceId, {
      runId: run.id,
      automationId: run.automationId,
      quietReplyEligible: (run.trigger === 'scheduled' || run.trigger === 'catchUp')
        && run.configSnapshot?.destination.kind === 'newInstance' && !run.configSnapshot.action.loop,
      seenAssistantOutput: false,
      outputChunks: [],
    });
    this.instanceByRun.set(run.id, instanceId);
    this.limits?.track(instanceId, run);
  }

  private handleProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    this.loopRunDispatcher?.observeProviderEvent(envelope);
    const root = this.limits?.observe(envelope.instanceId, envelope);
    if (root && root !== envelope.instanceId && envelope.event.kind === 'complete') {
      this.finishCompletedTurn(root);
    }
    const tracking = this.trackingByInstance.get(envelope.instanceId);
    if (!tracking) {
      this.earlyEvents.retain(envelope, this.instanceManager?.getInstance(envelope.instanceId), id => this.store.getRun(id)?.status === 'running');
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
        authorizeCompletion(tracking, this.instanceManager?.getInstance(envelope.instanceId), envelope);
        this.finishCompletedTurn(envelope.instanceId);
        break;
      case 'error':
        if (!envelope.event.recoverable) {
          // A stop Harness chose on purpose (a round past its token ceiling) is not transient: a retry would spend the same tokens again.
          this.failTrackedInstance(envelope.instanceId, envelope.event.message, harnessStopDetailsOf(envelope.event.details) ? { retryable: false } : undefined);
        }
        break;
      case 'exit':
        if (envelope.event.code === 0) this.finishCompletedTurn(envelope.instanceId);
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
    const root = this.limits?.observe(envelope.instanceId);
    if (root && root !== envelope.instanceId) {
      this.finishCompletedTurn(root);
    }
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

    // A run that parks awaiting human approval/input is a deterministic "needs a
    // human" outcome, not a transient error — retrying just spawns an identical
    // session that walks to the same gate and re-parks. Mark it non-retryable so
    // the run fails once without duplicating sessions. Claude's waiting_for_permission
    // is a held or live call that Harness may still answer from a saved rule, so it
    // ends the run when its ask reaches a person instead (see initialize()).
    if (event.status === 'waiting_for_input'
      || (event.status === 'waiting_for_permission' && this.instanceManager?.getInstance(envelope.instanceId)?.provider !== 'claude')) {
      this.failTrackedInstance(
        envelope.instanceId,
        event.status === 'waiting_for_permission'
          ? 'Automation requires unattended permission approval'
          : 'Automation requires unattended user input',
        { retryable: false },
      );
      return;
    }

    if (event.status === 'idle') this.finishCompletedTurn(envelope.instanceId);
  }

  /**
   * A held session sends nothing until the reset. Unless the hold resumes it
   * before the run's time limit, end the run now as a provider-limit stop (never
   * retried) and stop the session, which also cancels its scheduled resume.
   */
  private endRunHeldOnLimit({ instanceId, provider, resumeAt, autoResume }: ProviderLimitParkedEvent): void {
    const deadline = this.limits?.deadlineFor(instanceId);
    if (autoResume && deadline !== undefined && resumeAt < deadline) return;
    this.limits?.stopWith(instanceId, providerLimitParkedRunError(provider, resumeAt));
  }

  private handleInstanceRemoved(instanceId: string): void {
    this.limits?.removed(instanceId);
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
        onStopFailure: runId => { const run = this.store.getRun(runId); if (run) this.events.emitRunChanged({ automationId: run.automationId, run }); },
      });
    }
    return this.loopRunDispatcher;
  }

  private reconcileInstanceState(instance: Instance): void {
    const tracking = this.trackingByInstance.get(instance.id);
    if (!tracking) {
      return;
    }

    reconcileAutomationInstance(instance, tracking,
      (reason, options) => this.failTrackedInstance(instance.id, reason, options),
      () => this.finishCompletedTurn(instance.id),
      (provider, resumeAt) => this.endRunHeldOnLimit({ instanceId: instance.id, provider: provider as ProviderLimitParkedEvent['provider'],
        resumeAt, autoResume: getInstanceProviderLimitHandler().willAutoResume(instance.id) }));
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
    if (reportedStatus === 'succeeded' && this.limits?.check(instanceId)) return;
    const status = reportedStatus;
    const error = reportedError;
    this.limits?.clear(instanceId);
    const quietReply = tracking.quietReplyEligible && status === 'succeeded' && isQuietReply(tracking.lastAssistantOutput);
    const summarySource = quietReply && tracking.lastAssistantOutput
      ? stripQuietSentinel(tracking.lastAssistantOutput)
      : tracking.lastAssistantOutput;

    this.trackingByInstance.delete(instanceId);
    this.instanceByRun.delete(tracking.runId);

    stampHiddenAutomationOutcome(this.instanceManager, instanceId, status);

    const outputFullRef = writeFullOutput(tracking);
    let run = this.store.terminalizeRun(
      tracking.runId,
      status,
      error,
      summarySource ? summarySource.slice(0, 4000) : undefined,
      { now: this.now(), outputFullRef, monitorOutput: monitorAssistantOutput(tracking) },
    );
    if (!run) {
      return;
    }

    if (quietReply) {
      getAutomationCheckStore().setRunOutcome(run.id, 'quiet');
      this.store.markSeen({ runId: run.id });
      run = { ...run, outcome: 'quiet', seenAt: this.now() };
    }

    this.handleTerminalRun(run, options);
  }

  recordResult(instanceId: string | null, result: AutomationResult): { recorded: true } {
    if (!instanceId) throw new Error('automation_result requires a scheduled job session');
    const invocation = automationInvocations.get(instanceId);
    if (this.instanceManager?.getInstance(instanceId)?.parentId) throw new Error('Only the root scheduled job session can report its result');
    const metadataRunId = this.instanceManager?.getInstance(instanceId)?.metadata?.['automationRunId'];
    const runId = invocation?.runId ?? this.trackingByInstance.get(instanceId)?.runId ?? (typeof metadataRunId === 'string' ? metadataRunId : undefined);
    if (!runId) throw new Error('automation_result is only available to the scheduled job that owns this session');
    const run = this.store.getRun(runId);
    if (run && run.status !== 'running' && run.instanceId === instanceId) throw new Error(`This scheduled run has already ended (${run.status}${run.error ? `: ${run.error}` : ''}), so Harness cannot record its result and nothing will change that. Say what you found in your reply instead.`);
    if (!run || run.status !== 'running' || run.configSnapshot?.destination.kind !== 'newInstance' || run.configSnapshot.action.systemAction
      || (!invocation && run.instanceId !== null && run.instanceId !== instanceId)) throw new Error('automation_result requires an active owned agent run');
    this.store.recordResult(runId, result);
    return { recorded: true };
  }

  markDeliveryStartedForCaller(instanceId: string): void { markAutomationDelivery(instanceId, this.requireInstanceManager(), this.store); }
  hasStoppingRun(id: string): boolean { return this.limits?.isStoppingAutomation(id) === true || this.loopRunDispatcher?.isStoppingAutomation(id) === true || this.pauseStartup.isStoppingAutomation(id, runId => this.store.getRun(runId)?.automationId); }
  private refuseRetryWhileStopping(run: AutomationRun): boolean {
    if (run.attempt <= 1) return false;
    const current = this.store.getRun(run.id);
    if (!current || !['running', 'pending'].includes(current.status)) return true;
    if (!this.hasStoppingRun(run.automationId)) return false;
    const failed = this.store.terminalizeRun(run.id, 'failed', 'Previous scheduled job could not be stopped. Stop its sessions before running it again.', undefined, this.now());
    if (failed) this.handleTerminalRun(failed, { retryable: false });
    return true;
  }
  private reportStopFailure(runId: string): void {
    this.store.recordStopFailure(runId);
    const run = this.store.getRun(runId);
    if (run) this.events.emitRunChanged({ automationId: run.automationId, run });
  }

  private finishCompletedTurn(instanceId: string): void {
    const tracking = this.trackingByInstance.get(instanceId);
    if (!tracking) return;
    if (this.limits?.check(instanceId)) return;
    if (!isReceiptCurrent(tracking.completionReceipt, this.instanceManager?.getInstance(instanceId))) return;
    if (this.limits?.hasActiveDescendants(instanceId)) return;
    const error = completedAutomationTurnError(tracking, this.store.getRunFacts(tracking.runId).result, this.instanceManager?.getInstance(instanceId));
    if (error) {
      this.failTrackedInstance(instanceId, error, { retryable: false });
      return;
    }
    this.completeTrackedInstance(instanceId, 'succeeded');
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
    this.earlyEvents.discard(run.id);
    this.dispatchDeadline?.clear(run.id);
    handleTerminalRunImpl(this as unknown as AutomationTerminalRunHost, run, options);
  }

  private readonly notifyAutoDisabled = notifyAutomationDisabled;

  recordGiveUpOutcome(originalRun: AutomationRun): void {
    if (originalRun.configSnapshot?.action.preCheck) getAutomationCheckStore().clearPending(originalRun.id);
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

  /** Reserve the retry's deadline and stop fence before the scheduler waits for network. */
  prepareRetryRun(retryRun: AutomationRun): boolean {
    const current = this.store.getRun(retryRun.id);
    if (!current || current.status !== 'running') return false;
    if (!retryRun.configSnapshot) {
      const failed = this.store.terminalizeRun(retryRun.id, 'failed', 'Retry run has no config snapshot', undefined, this.now());
      if (failed) this.handleTerminalRun(failed, { retryable: false });
      return false;
    }
    if (this.refuseRetryWhileStopping(retryRun)) return false;
    this.dispatchDeadline?.arm(retryRun);
    return this.store.getRun(retryRun.id)?.status === 'running';
  }

  /** Recheck admission when a network wait, held dispatch or direct caller releases a retry. */
  async dispatchRetryRun(retryRun: AutomationRun): Promise<void> {
    if (!this.prepareRetryRun(retryRun)) return;
    await this.dispatchRun({ run: retryRun, snapshot: retryRun.configSnapshot!, automation: automationShellFromRunSnapshot(retryRun) }, this.requireInstanceManager());
  }
}
