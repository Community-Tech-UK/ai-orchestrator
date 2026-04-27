import { getLogger } from '../logging/logger';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
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

const logger = getLogger('AutomationRunner');

interface RunTracking {
  runId: string;
  automationId: string;
  seenAssistantOutput: boolean;
  lastAssistantOutput?: string;
}

const FAILURE_STATUSES = new Set<InstanceStatus>([
  'error',
  'failed',
  'terminated',
  'cancelled',
  'superseded',
]);

const WAIT_STATUSES = new Set<InstanceStatus>([
  'waiting_for_input',
  'waiting_for_permission',
]);

export class AutomationRunner {
  private instanceManager: InstanceManager | null = null;
  private readonly trackingByInstance = new Map<string, RunTracking>();
  private readonly instanceByRun = new Map<string, string>();
  private initialized = false;

  constructor(
    private readonly store: AutomationStore,
    private readonly events = getAutomationEvents(),
    private readonly now = () => Date.now(),
  ) {}

  initialize(instanceManager: InstanceManager): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.instanceManager = instanceManager;

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

  async fire(automationId: string, options: FireAutomationOptions): Promise<AutomationFireOutcome> {
    const manager = this.requireInstanceManager();
    const fireTime = options.scheduledAt ?? this.now();
    const automation = await this.store.get(automationId);
    const decision = this.store.decideAndInsertRun(
      automation,
      options.trigger,
      fireTime,
      this.now(),
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
        this.events.emitRunChanged({ automationId: failed.automationId, run: failed });
        this.events.emitRunTerminal({
          automationId: failed.automationId,
          runId: failed.id,
          status: failed.status as Exclude<AutomationRunStatus, 'pending' | 'running'>,
        });
        if (this.isOneTimeRun(failed)) {
          this.emitAutomationState(failed.automationId);
          this.events.emitScheduleDeactivated({ automationId: failed.automationId });
        }
        await this.promotePendingIfAny(failed.automationId);
      }
    }
  }

  private trackInstance(instanceId: string, run: AutomationRun): void {
    this.trackingByInstance.set(instanceId, {
      runId: run.id,
      automationId: run.automationId,
      seenAssistantOutput: false,
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

    const run = this.store.terminalizeRun(
      tracking.runId,
      status,
      error,
      tracking.lastAssistantOutput ? tracking.lastAssistantOutput.slice(0, 4000) : undefined,
      this.now(),
    );
    if (!run) {
      return;
    }

    this.events.emitRunChanged({ automationId: run.automationId, run });
    this.events.emitRunTerminal({
      automationId: run.automationId,
      runId: run.id,
      status: run.status as Exclude<AutomationRunStatus, 'pending' | 'running'>,
    });
    if (this.isOneTimeRun(run)) {
      this.emitAutomationState(run.automationId);
      this.events.emitScheduleDeactivated({ automationId: run.automationId });
    }
    this.promotePendingIfAny(run.automationId).catch((promoteError) => {
      logger.warn('Failed to promote pending automation run', {
        automationId: run.automationId,
        error: promoteError instanceof Error ? promoteError.message : String(promoteError),
      });
    });
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
}
