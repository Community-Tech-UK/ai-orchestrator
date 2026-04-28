import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
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
import type { ChannelPlatform } from '../../shared/types/channels';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { InstanceEventEnvelope } from '@contracts/types/instance-events';
import { AutomationStore } from './automation-store';
import { getAutomationEvents } from './automation-events';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getArtifactAttributionStore } from '../session/artifact-attribution-store';
import { getChannelManager } from '../channels/channel-manager';

const logger = getLogger('AutomationRunner');

function getUserDataPath(): string {
  const electronApp = app as { getPath?: (name: string) => string } | undefined;
  return typeof electronApp?.getPath === 'function'
    ? electronApp.getPath('userData')
    : path.join(os.tmpdir(), 'ai-orchestrator');
}

interface RunTracking {
  runId: string;
  automationId: string;
  seenAssistantOutput: boolean;
  lastAssistantOutput?: string;
  outputChunks: Array<{
    kind: string;
    content?: string;
    timestamp: number;
  }>;
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

const CHANNEL_DELIVERY_MAX_CHARS = 3500;

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
      {
        idempotencyKey: options.idempotencyKey,
        triggerSource: options.triggerSource,
        deliveryMode: options.deliveryMode,
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
	        emitPluginHook('automation.run.failed', {
	          automationId: failed.automationId,
	          runId: failed.id,
	          status: failed.status,
	          error: failed.error ?? undefined,
	          outputFullRef: failed.outputFullRef ?? undefined,
	          timestamp: Date.now(),
	        });
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

    const outputFullRef = this.writeFullOutput(tracking);
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
    if (this.isOneTimeRun(run)) {
      this.emitAutomationState(run.automationId);
      this.events.emitScheduleDeactivated({ automationId: run.automationId });
    }
    this.deliverRunSummaryToChannel(run).catch((deliveryError) => {
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

  private failTrackedInstance(instanceId: string, reason: string): void {
    this.completeTrackedInstance(instanceId, 'failed', reason);
  }

  private writeFullOutput(tracking: RunTracking): string | undefined {
    if (tracking.outputChunks.length === 0 && !tracking.lastAssistantOutput) {
      return undefined;
    }

    try {
      const outputDir = path.join(getUserDataPath(), 'automation-run-output');
      fs.mkdirSync(outputDir, { recursive: true });
      const filePath = path.join(outputDir, `${tracking.runId}.json`);
      fs.writeFileSync(filePath, JSON.stringify({
        runId: tracking.runId,
        automationId: tracking.automationId,
        lastAssistantOutput: tracking.lastAssistantOutput,
        events: tracking.outputChunks,
        capturedAt: Date.now(),
      }, null, 2), 'utf-8');
      getArtifactAttributionStore().registerArtifact({
        ownerType: 'automation_run',
        ownerId: tracking.runId,
        kind: 'automation_full_output',
        path: filePath,
      });
      return filePath;
    } catch (error) {
      logger.warn('Failed to persist full automation output', {
        runId: tracking.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private isOneTimeRun(run: AutomationRun): boolean {
    return run.configSnapshot?.schedule.type === 'oneTime';
  }

  private async deliverRunSummaryToChannel(run: AutomationRun): Promise<void> {
    if (run.deliveryMode !== 'notify') {
      return;
    }
    const target = this.getChannelDeliveryTarget(run);
    if (!target) {
      return;
    }

    const adapter = getChannelManager().getAdapter(target.platform);
    if (!adapter) {
      return;
    }

    const content = this.formatChannelRunSummary(run);
    const sent = await adapter.sendMessage(target.chatId, content, target.replyToMessageId
      ? { replyTo: target.replyToMessageId }
      : undefined);
    getChannelManager().emitResponseSent({
      channelMessageId: target.replyToMessageId ?? run.id,
      platform: target.platform,
      chatId: target.chatId,
      messageId: sent.messageId,
      instanceId: run.instanceId ?? run.id,
      content,
      status: run.status === 'failed' ? 'error' : 'complete',
      replyToMessageId: target.replyToMessageId,
      timestamp: Date.now(),
    });
  }

  private getChannelDeliveryTarget(run: AutomationRun): {
    platform: ChannelPlatform;
    chatId: string;
    replyToMessageId?: string;
  } | null {
    const source = run.triggerSource;
    if (!source?.channel && !source?.metadata) {
      return null;
    }
    const metadata = source.metadata ?? {};
    const channelParts = typeof source.channel === 'string'
      ? source.channel.split(':')
      : [];
    const platform = this.toChannelPlatform(metadata['platform'])
      ?? this.toChannelPlatform(channelParts[0]);
    const chatId = typeof metadata['chatId'] === 'string'
      ? metadata['chatId']
      : channelParts.length > 1
        ? channelParts.slice(1).join(':')
        : undefined;
    if (!platform || !chatId) {
      return null;
    }
    const replyToMessageId = typeof metadata['replyToMessageId'] === 'string'
      ? metadata['replyToMessageId']
      : typeof metadata['messageId'] === 'string'
        ? metadata['messageId']
        : undefined;
    return { platform, chatId, replyToMessageId };
  }

  private toChannelPlatform(value: unknown): ChannelPlatform | null {
    return value === 'discord' || value === 'whatsapp' ? value : null;
  }

  private formatChannelRunSummary(run: AutomationRun): string {
    const name = run.configSnapshot?.name ?? run.automationId;
    const status = run.status === 'succeeded'
      ? 'succeeded'
      : run.status === 'failed'
        ? 'failed'
        : run.status;
    const body = run.outputSummary ?? run.error ?? 'No summary was captured.';
    const text = `Automation "${name}" ${status}.\n\n${body}`;
    return text.length > CHANNEL_DELIVERY_MAX_CHARS
      ? `${text.slice(0, CHANNEL_DELIVERY_MAX_CHARS - 3)}...`
      : text;
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
