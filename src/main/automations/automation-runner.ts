import { getLogger } from '../logging/logger';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import type {
  Automation,
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
import { emitPluginHook } from '../plugins/hook-emitter';
import { dispatchAutomationSystemAction } from './automation-system-action-dispatch';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  computeRetryDelayMs,
} from './automation-retry';
import {
  deliverRunSummaryToChannel,
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
  private retryScheduler: RetrySchedulerCallback | null = null;

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

    instanceManager.on('provider:normalized-event', (envelope: ProviderRuntimeEventEnvelope) => {
      this.handleProviderEvent(envelope);
    });
    instanceManager.on('instance:event', (envelope: InstanceEventEnvelope) => {
      this.handleInstanceEvent(envelope);
    });
    instanceManager.on('instance:removed', (instanceId: string) => {
      this.handleInstanceRemoved(instanceId);
    });

    const failed = this.store.failRunningRuns('App restarted before automation run completed', this.now());
    for (const run of failed) {
      this.events.emitRunChanged({ automationId: run.automationId, run });
      this.events.emitRunTerminal({ automationId: run.automationId, runId: run.id, status: 'failed' });
      if (this.isOneTimeRun(run)) {
        this.emitAutomationState(run.automationId);
        this.events.emitScheduleDeactivated({ automationId: run.automationId });
      }
    }
  }

  async fire(automationId: string, options: AutomationFireOptions): Promise<AutomationFireOutcome> {
    const manager = this.requireInstanceManager();
    const fireTime = options.scheduledAt ?? this.now();
    const automation = await this.store.get(automationId);
    const promptOverride = options.trigger === 'webhook' && options.webhookPayload && automation
      ? renderWebhookPromptTemplate(automation.action.prompt, options.webhookPayload).content
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
    emitPluginHook('automation.run.started', {
      automationId: run.automationId,
      runId: run.id,
      trigger: run.trigger,
      source: run.triggerSource ?? undefined,
      deliveryMode: run.deliveryMode,
      timestamp: Date.now(),
    });
    await this.dispatchRun({
      run,
      automation: automation as Automation,
      snapshot: run.configSnapshot!,
    }, manager);
    return { status: 'started', run };
  }

  async promotePendingIfAny(automationId?: string): Promise<void> {
    const manager = this.requireInstanceManager();
    const claimed = this.store.claimNextPending(automationId, this.now());
    if (!claimed) {
      return;
    }
    this.events.emitRunChanged({ automationId: claimed.run.automationId, run: claimed.run });
    await this.dispatchRun(claimed, manager);
  }

  untrackInstances(instanceIds: string[]): void {
    for (const instanceId of instanceIds) {
      const tracking = this.trackingByInstance.get(instanceId);
      if (tracking) {
        this.instanceByRun.delete(tracking.runId);
      }
      this.trackingByInstance.delete(instanceId);
    }
  }

  private async dispatchRun(claimed: ClaimedAutomationRun, manager: InstanceManager): Promise<void> {
    const systemRun = this.dispatchSystemActionIfHandled(claimed);
    if (systemRun) {
      this.handleTerminalRun(systemRun);
      return;
    }

    if (claimed.snapshot.destination.kind === 'thread') {
      const terminal = await this.requireThreadWakeupRunner().fireThreadWakeup({
        run: claimed.run,
        automation: automationFromSnapshot(claimed.automation, claimed.snapshot),
        destination: claimed.snapshot.destination,
      });
      this.handleTerminalRun(terminal);
      return;
    }

    try {
      const instance = await manager.createInstance({
        displayName: `Automation: ${claimed.snapshot.name}`,
        workingDirectory: claimed.snapshot.action.workingDirectory,
        initialPrompt: claimed.snapshot.action.prompt,
        attachments: claimed.snapshot.action.attachments,
        yoloMode: claimed.snapshot.action.yoloMode,
        agentId: claimed.snapshot.action.agentId,
        provider: claimed.snapshot.action.provider,
        modelOverride: claimed.snapshot.action.model,
        forceNodeId: claimed.snapshot.action.forceNodeId,
        reasoningEffort: claimed.snapshot.action.reasoningEffort,
        // Durable provenance so the rail can mark this session as automation-born
        // (with a clock indicator) even after AI auto-titling rewrites the
        // "Automation: …" displayName. Survives archive into the history entry.
        metadata: {
          automationId: claimed.run.automationId,
          automationRunId: claimed.run.id,
        },
      });

      this.trackInstance(instance.id, claimed.run);
      const attachedRun = this.store.attachInstance(claimed.run.id, instance.id, this.now());
      if (attachedRun) {
        this.events.emitRunChanged({ automationId: attachedRun.automationId, run: attachedRun });
      }

      this.reconcileInstanceState(instance);
      instance.readyPromise?.catch((error: unknown) => {
        this.failTrackedInstance(
          instance.id,
          `Automation dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
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
      this.failTrackedInstance(
        envelope.instanceId,
        event.status === 'waiting_for_permission'
          ? 'Automation requires unattended permission approval'
          : 'Automation requires unattended user input',
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

  private dispatchSystemActionIfHandled(claimed: ClaimedAutomationRun): AutomationRun | null {
    return dispatchAutomationSystemAction(claimed, { store: this.store, now: () => this.now() });
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
    tracking.outputChunks.push(...instance.outputBuffer.slice(-20).map((message) => ({
      kind: message.type,
      content: message.content,
      timestamp: message.timestamp,
    })));

    if (FAILURE_STATUSES.has(instance.status)) {
      this.failTrackedInstance(instance.id, `Instance entered ${instance.status}`);
      return;
    }

    if (WAIT_STATUSES.has(instance.status)) {
      this.failTrackedInstance(
        instance.id,
        instance.status === 'waiting_for_permission'
          ? 'Automation requires unattended permission approval'
          : 'Automation requires unattended user input',
      );
      return;
    }

    if (instance.status === 'idle' && tracking.seenAssistantOutput) {
      this.completeTrackedInstance(instance.id, 'succeeded');
    }
  }

  private completeTrackedInstance(
    instanceId: string,
    status: Exclude<AutomationRunStatus, 'pending' | 'running'>,
    error?: string,
  ): void {
    const tracking = this.trackingByInstance.get(instanceId);
    if (!tracking) {
      return;
    }

    this.trackingByInstance.delete(instanceId);
    this.instanceByRun.delete(tracking.runId);

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

    this.handleTerminalRun(run);
  }

  private failTrackedInstance(instanceId: string, reason: string): void {
    this.completeTrackedInstance(instanceId, 'failed', reason);
  }

  private isOneTimeRun(run: AutomationRun): boolean {
    return run.configSnapshot?.schedule.type === 'oneTime';
  }

  private emitAutomationState(automationId: string): void {
    this.store.get(automationId).then((automation) => {
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

  private handleTerminalRun(run: AutomationRun): void {
    this.events.emitRunChanged({ automationId: run.automationId, run });
    this.events.emitRunTerminal({
      automationId: run.automationId,
      runId: run.id,
      status: run.status as Exclude<AutomationRunStatus, 'pending' | 'running'>,
    });
    if (run.status === 'failed') {
      emitPluginHook('automation.run.failed', {
        automationId: run.automationId,
        runId: run.id,
        status: run.status,
        error: run.error ?? undefined,
        outputFullRef: run.outputFullRef ?? undefined,
        timestamp: Date.now(),
      });
    } else {
      emitPluginHook('automation.run.completed', {
        automationId: run.automationId,
        runId: run.id,
        status: run.status,
        outputSummary: run.outputSummary ?? undefined,
        outputFullRef: run.outputFullRef ?? undefined,
        timestamp: Date.now(),
      });
    }

    // Resilience: retry/backoff + consecutive-failure tracking (B10a/B10b).
    //
    // On a failed run, check if more attempts are available. If so, schedule a
    // retry — intermediate failures do NOT increment the consecutive-failure
    // streak so a transient error doesn't cause an early auto-disable. Only the
    // final give-up (all attempts exhausted) records the outcome and may
    // auto-disable the automation.
    //
    // On success, always record the outcome immediately to reset the streak.
    if (run.status === 'failed') {
      const attempt = run.attempt ?? 1;
      const maxAttempts = run.maxAttempts ?? 1;
      if (attempt < maxAttempts && this.retryScheduler) {
        const delayMs = computeRetryDelayMs(run.automationId, attempt, this.baseRetryDelayMs);
        logger.info('Scheduling automation retry', {
          automationId: run.automationId,
          runId: run.id,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
        });
        this.retryScheduler(run, attempt + 1, maxAttempts, delayMs);
        // Intentionally skip recordRunOutcome — the streak must not be
        // incremented for intermediate retry failures.
      } else {
        // Final attempt — record the failure and possibly auto-disable.
        const outcome = this.store.recordRunOutcome(
          run.automationId,
          run.status,
          run.error ?? undefined,
          this.now(),
        );
        if (outcome.autoDisabled) {
          logger.warn('Automation auto-disabled after repeated failures', {
            automationId: run.automationId,
            consecutiveFailures: outcome.automation?.consecutiveFailures,
            lastFailureReason: run.error ?? undefined,
          });
          this.emitAutomationState(run.automationId);
          this.events.emitScheduleDeactivated({ automationId: run.automationId });
        }
      }
    } else if (run.status === 'succeeded') {
      const outcome = this.store.recordRunOutcome(
        run.automationId,
        run.status,
        undefined,
        this.now(),
      );
      if (outcome.autoDisabled) {
        // Shouldn't happen on success, but guard defensively.
        this.emitAutomationState(run.automationId);
        this.events.emitScheduleDeactivated({ automationId: run.automationId });
      }
    }

    if (this.isOneTimeRun(run)) {
      this.emitAutomationState(run.automationId);
      // BUG 1 FIX (runner side): do NOT emit schedule-deactivated for a failed
      // oneTime run when a retry is still pending.  schedule-deactivated triggers
      // a full deactivate() in the scheduler, which would immediately cancel the
      // retry timer we just armed above.  A retry is pending when this run is
      // failed AND attempt < maxAttempts AND a retryScheduler is registered.
      const hasRetryPending =
        run.status === 'failed' &&
        (run.attempt ?? 1) < (run.maxAttempts ?? 1) &&
        this.retryScheduler !== null;
      if (!hasRetryPending) {
        this.events.emitScheduleDeactivated({ automationId: run.automationId });
      }
    }
    deliverRunSummaryToChannel(run).catch((deliveryError) => {
      logger.warn('Failed to deliver automation run summary to channel', {
        automationId: run.automationId,
        runId: run.id,
        error: deliveryError instanceof Error ? deliveryError.message : String(deliveryError),
      });
    });
    this.promotePendingIfAny(run.automationId).catch((promoteError) => {
      logger.warn('Failed to promote pending automation run', {
        automationId: run.automationId,
        error: promoteError instanceof Error ? promoteError.message : String(promoteError),
      });
    });
  }

  /**
   * Record a give-up outcome for a run whose last retry attempt was abandoned
   * due to a concurrency-policy skip.  This keeps the consecutive-failure streak
   * accurate even when a retry is skipped for non-error reasons.
   *
   * Called from AutomationScheduler.onRetryTimer when concurrencyPolicy=skip
   * and the retry timer fires but a run is still active.
   */
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
      this.emitAutomationState(originalRun.automationId);
      this.events.emitScheduleDeactivated({ automationId: originalRun.automationId });
    }
  }

  /**
   * Dispatch a retry run that was created by the scheduler when the retry
   * timer fires.  Called from `AutomationScheduler.onRetryTimer`.
   */
  async dispatchRetryRun(retryRun: AutomationRun): Promise<void> {
    const manager = this.requireInstanceManager();
    this.events.emitRunChanged({ automationId: retryRun.automationId, run: retryRun });
    emitPluginHook('automation.run.started', {
      automationId: retryRun.automationId,
      runId: retryRun.id,
      trigger: retryRun.trigger,
      source: retryRun.triggerSource ?? undefined,
      deliveryMode: retryRun.deliveryMode,
      timestamp: Date.now(),
    });

    const snapshotForSystemAction = retryRun.configSnapshot;
    if (snapshotForSystemAction) {
      const systemRun = this.dispatchSystemActionIfHandled({
        run: retryRun,
        automation: automationShellFromRunSnapshot(retryRun),
        snapshot: snapshotForSystemAction,
      });
      if (systemRun) {
        this.handleTerminalRun(systemRun);
        return;
      }
    }

    if (retryRun.configSnapshot?.destination.kind === 'thread') {
      const terminal = await this.requireThreadWakeupRunner().fireThreadWakeup({
        run: retryRun,
        automation: automationFromSnapshot(automationShellFromRunSnapshot(retryRun), retryRun.configSnapshot),
        destination: retryRun.configSnapshot.destination,
      });
      this.handleTerminalRun(terminal);
      return;
    }

    try {
      const snapshot = retryRun.configSnapshot;
      if (!snapshot) {
        throw new Error('Retry run has no config snapshot');
      }
      const instance = await manager.createInstance({
        displayName: `Automation: ${snapshot.name} (retry ${retryRun.attempt})`,
        workingDirectory: snapshot.action.workingDirectory,
        initialPrompt: snapshot.action.prompt,
        attachments: snapshot.action.attachments,
        yoloMode: snapshot.action.yoloMode,
        agentId: snapshot.action.agentId,
        provider: snapshot.action.provider,
        modelOverride: snapshot.action.model,
        forceNodeId: snapshot.action.forceNodeId,
        reasoningEffort: snapshot.action.reasoningEffort,
        // Same durable provenance as the first attempt so the rail marks the
        // retry session as automation-born and viewing it clears the badge.
        metadata: {
          automationId: retryRun.automationId,
          automationRunId: retryRun.id,
        },
      });

      this.trackInstance(instance.id, retryRun);
      const attachedRun = this.store.attachInstance(retryRun.id, instance.id, this.now());
      if (attachedRun) {
        this.events.emitRunChanged({ automationId: attachedRun.automationId, run: attachedRun });
      }

      this.reconcileInstanceState(instance);
      instance.readyPromise?.catch((error: unknown) => {
        this.failTrackedInstance(
          instance.id,
          `Automation retry dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    } catch (error) {
      const failed = this.store.terminalizeRun(
        retryRun.id,
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
}
