import { getContextEngine } from '../context/context-engine';
import { evaluateContextWindowGuard } from '../context/context-window-guard';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getDoomLoopDetector } from '../orchestration/doom-loop-detector';
import type { UserActionRequest } from '../orchestration/orchestration-handler';
import { getOrchestrationActivityBridge } from '../orchestration/orchestration-activity-bridge';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getLogger } from '../logging/logger';
import { getMemoryMonitor } from '../memory';
import { getRemoteObserverServer } from '../remote/observer-server';
import { getRepoJobService } from '../repo-jobs';
import {
  getSessionContinuityManager,
} from '../session/session-continuity';
import {
  getAppStore,
  setGlobalState,
} from '../state';
import { getLoadBalancer } from '../process/load-balancer';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { recordProviderRuntimeEventSpan } from '../observability/otel-spans';
import { getProviderRuntimeTraceSink } from '../observability/provider-runtime-trace-sink';
import { BoundedAsyncQueue } from '../runtime/bounded-async-queue';
import { recordProviderThreadCompactionMarker } from './compaction-runtime';
import { IPC_CHANNELS } from '@contracts/channels';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import { isFastModeUnavailableNotice } from '../instance/lifecycle/fast-mode-notice';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import type { Instance, InstanceStatus, OutputMessage } from '../../shared/types/instance.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

const logger = getLogger('InstanceEventForwarding');

export interface InstanceEventForwardingOptions {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
  isStatelessExecProvider: (provider: string | undefined) => boolean;
  getNodeLatencyForInstance: (instanceId: string) => number | undefined;
}

function isProviderThreadCompactionMessage(message: OutputMessage): boolean {
  return message.metadata?.['threadCompacted'] === true;
}

type ContinuityTask =
  | { kind: 'state'; instanceId: string; update: Record<string, unknown> }
  | { kind: 'entry'; instanceId: string; entry: { id: string; role: 'user' | 'assistant' | 'system' | 'tool'; content: string; timestamp: number } };

const ACTIVE_STATUSES = new Set(['running', 'busy', 'waiting', 'waiting_for_input']);

export function setupInstanceEventForwarding(options: InstanceEventForwardingOptions): void {
  const { instanceManager, windowManager, isStatelessExecProvider, getNodeLatencyForInstance } = options;
  const observer = getRemoteObserverServer();
  const repoJobs = getRepoJobService();
  const traceSink = getProviderRuntimeTraceSink();

  // Track previous statuses so we can detect active → idle transitions.
  const previousStatus = new Map<string, string>();

  // Continuity updates run off the hot event path. State updates coalesce per
  // instance (bounded queue, drop when full); entry ordering is preserved.
  const continuityQueue = new BoundedAsyncQueue<ContinuityTask>({
    name: 'session-continuity',
    maxSize: 2_000,
    concurrency: 1,
    process: async (task) => {
      try {
        const continuity = getSessionContinuityManager();
        // C2: await the async continuity writes so the queue serializes them
        // correctly and errors surface instead of being silently dropped.
        if (task.kind === 'state') {
          await continuity.updateState(task.instanceId, task.update as Parameters<typeof continuity.updateState>[1]);
        } else {
          await continuity.addConversationEntry(task.instanceId, task.entry);
        }
      } catch (err) {
        logger.warn('Continuity queue task failed', {
          kind: task.kind,
          instanceId: task.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    onDrop: (_, reason) => {
      if (reason === 'capacity') {
        logger.debug('Continuity queue dropped task (capacity)');
      }
    },
  });

  instanceManager.on('instance:created', (instance) => {
    windowManager.sendToRenderer('instance:created', instance);
    observer.publishInstanceState({
      type: 'created',
      instanceId: instance.id,
      displayName: instance.displayName,
      status: instance.status,
    });
    try {
      getSessionContinuityManager().startTracking(instance);
    } catch (error) {
      logger.warn('Failed to start session tracking', {
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  instanceManager.on('instance:removed', (instanceId) => {
    windowManager.sendToRenderer('instance:removed', instanceId);
    getContextEngine().cleanupInstance(instanceId as string);
    getDoomLoopDetector().cleanupInstance(instanceId as string);
    getLoadBalancer().removeMetrics(instanceId as string);
    getWorkflowManager().cleanupInstance(instanceId as string);
    previousStatus.delete(instanceId as string);
    observer.publishInstanceState({
      type: 'removed',
      instanceId,
    });
    try {
      getSessionContinuityManager().stopTracking(instanceId as string, true);
    } catch (error) {
      logger.warn('Failed to stop session tracking', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  instanceManager.on('instance:state-update', (update) => {
    windowManager.sendToRenderer('instance:state-update', update);
    observer.publishInstanceState(update as Record<string, unknown>);
  });

  // Fast-mode changes (user toggle confirmation + provider auto-revert) so the
  // renderer can sync the per-instance toggle and toast on unavailability.
  instanceManager.on('instance:fast-toggled', (payload) => {
    windowManager.sendToRenderer(IPC_CHANNELS.INSTANCE_FAST_TOGGLED, payload);
  });

  instanceManager.on('provider:normalized-event', (envelope: ProviderRuntimeEventEnvelope) => {
    const instance = instanceManager.getInstance(envelope.instanceId);
    let enrichedEnvelope: ProviderRuntimeEventEnvelope = envelope.model || !instance?.currentModel
      ? envelope
      : { ...envelope, model: instance.currentModel };

    let message = toOutputMessageFromProviderEnvelope(enrichedEnvelope);
    if (message && isProviderThreadCompactionMessage(message)) {
      const markerId = recordProviderThreadCompactionMarker({
        instanceId: enrichedEnvelope.instanceId,
        instance,
        provider: enrichedEnvelope.provider,
        sessionId: enrichedEnvelope.sessionId,
        messageId: message.id,
        createdAt: message.timestamp,
        messageMetadata: message.metadata,
      });
      if (markerId) {
        const metadata = {
          ...(enrichedEnvelope.event.kind === 'output' ? enrichedEnvelope.event.metadata : {}),
          compactionMarkerId: markerId,
          isCompactionBoundary: true,
          method: 'self-managed',
        };
        enrichedEnvelope = {
          ...enrichedEnvelope,
          event: enrichedEnvelope.event.kind === 'output'
            ? { ...enrichedEnvelope.event, metadata }
            : enrichedEnvelope.event,
        };
        message = {
          ...message,
          metadata: {
            ...message.metadata,
            compactionMarkerId: markerId,
            isCompactionBoundary: true,
            method: 'self-managed',
          },
        };
      }
    }

    if (process.env['NODE_ENV'] !== 'production') {
      ProviderRuntimeEventEnvelopeSchema.parse(enrichedEnvelope);
    }

    // Lightweight OTel span only for diagnostic event kinds (error/complete/context/exit).
    // High-frequency output events route to the NDJSON trace sink instead.
    recordProviderRuntimeEventSpan(enrichedEnvelope);
    traceSink.enqueue(enrichedEnvelope);

    // Renderer IPC — the only synchronous operation in this hot path.
    windowManager.sendToRenderer(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, enrichedEnvelope);

    if (!message) return;

    // Auto-revert: when the provider reports fast mode is unavailable (no paid
    // tier / ineligible plan), flip the stored preference off without restarting
    // (the session already ran without it). The notice itself stays in the
    // transcript, surfacing the reason to the user.
    if (instance?.fastMode && isFastModeUnavailableNotice(message.content)) {
      void instanceManager
        .setFastMode(enrichedEnvelope.instanceId, false, { restart: false, reason: 'unavailable' })
        .catch((error) => {
          logger.warn('Failed to auto-revert fast mode after unavailable notice', {
            instanceId: enrichedEnvelope.instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }

    observer.publishInstanceOutput(enrichedEnvelope.instanceId, message);

    // Session continuity runs off-path through a bounded queue.
    if (instance) {
      const stateUpdate: Record<string, unknown> = {
        sessionId: instance.sessionId,
        historyThreadId: instance.historyThreadId,
        provider: instance.provider,
        displayName: instance.displayName,
        workingDirectory: instance.workingDirectory,
      };
      if (instance.currentModel) stateUpdate['modelId'] = instance.currentModel;
      continuityQueue.enqueue({ kind: 'state', instanceId: envelope.instanceId, update: stateUpdate });
    }

    if (
      message.type === 'user' ||
      message.type === 'assistant' ||
      message.type === 'tool_use' ||
      message.type === 'tool_result'
    ) {
      continuityQueue.enqueue({
        kind: 'entry',
        instanceId: envelope.instanceId,
        entry: {
          id: message.id || `msg-${Date.now()}`,
          role: (message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'tool') as 'user' | 'assistant' | 'tool',
          content: message.content || '',
          timestamp: message.timestamp || Date.now(),
        },
      });
    }
  });

  instanceManager.on('instance:batch-update', (updates) => {
    windowManager.sendToRenderer('instance:batch-update', updates);
    observer.publishInstanceState({
      type: 'batch-update',
      ...(updates as Record<string, unknown>),
    });

    const data = updates as {
      updates?: {
        instanceId: string;
        status?: string;
        contextUsage?: { used: number; total: number; percentage: number };
      }[];
    };
    if (data.updates) {
      const contextEngine = getContextEngine();
      for (const update of data.updates) {
        if (update.contextUsage) {
          const instance = instanceManager.getInstance(update.instanceId);
          if (isStatelessExecProvider(instance?.provider)) {
            continue;
          }

          contextEngine.onContextUpdate(update.instanceId, update.contextUsage);
          const remaining = update.contextUsage.total - update.contextUsage.used;
          const guardResult = evaluateContextWindowGuard(remaining);
          if (guardResult.shouldWarn || !guardResult.allowed) {
            windowManager.sendToRenderer('context:warning', {
              instanceId: update.instanceId,
              ...guardResult,
            });
          }
        }
      }
    }
    if (data.updates) {
      const loadBalancer = getLoadBalancer();
      for (const update of data.updates) {
        if (update.contextUsage) {
          // C2: Route through the continuity queue instead of calling directly,
          // so writes are serialized and awaited correctly.
          continuityQueue.enqueue({
            kind: 'state',
            instanceId: update.instanceId,
            update: {
              contextUsage: {
                used: update.contextUsage.used,
                total: update.contextUsage.total,
              },
            },
          });
        }
        if (update.instanceId) {
          loadBalancer.updateMetrics(update.instanceId, {
            activeTasks: 0,
            contextUsagePercent: update.contextUsage
              ? Math.round((update.contextUsage.used / update.contextUsage.total) * 100)
              : 0,
            memoryPressure: 'normal',
            status: update.status || 'idle',
            nodeLatencyMs: getNodeLatencyForInstance(update.instanceId),
          });
        }
      }
    }
  });

  const crossModelReview = getCrossModelReviewService();

  instanceManager.on('provider:normalized-event', (envelope) => {
    const message = toOutputMessageFromProviderEnvelope(envelope);
    if (!message || message.metadata?.['source'] === 'cross-model-review') return;
    const instance = instanceManager.getInstance(envelope.instanceId);
    const provider = instance?.provider ?? envelope.provider;
    const firstUserPrompt = instance?.displayName ?? '';
    crossModelReview.bufferMessage(
      envelope.instanceId,
      message.type,
      message.content,
      provider as string,
      firstUserPrompt,
    );
  });

  instanceManager.on('instance:batch-update', ({ updates }) => {
    for (const update of updates) {
      if (update.status === 'idle' || update.status === 'waiting_for_input') {
        crossModelReview.onInstanceIdle(update.instanceId).catch(err =>
          logger.warn('Review trigger failed', {
            instanceId: update.instanceId,
            error: String(err),
          })
        );
      }
    }
  });

  instanceManager.on('instance:removed', (instanceId: string) => {
    crossModelReview.cancelPendingReviews(instanceId);
    previousStatus.delete(instanceId);
  });

  crossModelReview.on('review:started', (data) => {
    windowManager.sendToRenderer('cross-model-review:started', data);
  });
  crossModelReview.on('review:result', (data) => {
    windowManager.sendToRenderer('cross-model-review:result', data);
  });
  crossModelReview.on('review:all-unavailable', (data) => {
    windowManager.sendToRenderer('cross-model-review:all-unavailable', data);
  });

  instanceManager.on('instance:input-required', (payload) => {
    windowManager.sendToRenderer('instance:input-required', payload);
    observer.recordPrompt({
      id: payload.requestId,
      promptType: 'input-required',
      instanceId: payload.instanceId,
      requestId: payload.requestId,
      createdAt: payload.timestamp || Date.now(),
      title: 'Input Required',
      message: payload.prompt,
    });
  });

  getDoomLoopDetector().on('doom-loop-detected', (event) => {
    logger.warn('Forwarding doom loop event to renderer', {
      instanceId: event.instanceId,
      toolName: event.toolName,
    });
    windowManager.sendToRenderer('instance:doom-loop', event);
  });

  const orchestration = instanceManager.getOrchestrationHandler();
  orchestration.on('user-action-request', (request: UserActionRequest) => {
    logger.info('Forwarding user action request to renderer', { requestId: request.id });
    windowManager.sendToRenderer('user-action:request', request);
    observer.recordPrompt({
      id: request.id,
      promptType: 'user-action',
      instanceId: request.instanceId,
      requestId: request.id,
      createdAt: request.createdAt,
      title: request.title,
      message: request.message,
      options: request.options?.map((option) => option.label) || request.questions,
    });

    let title: string;
    switch (request.requestType) {
      case 'switch_mode': {
        const modeLabel = request.targetMode
          ? `${request.targetMode.charAt(0).toUpperCase()}${request.targetMode.slice(1)}`
          : 'requested';
        title = `Approval Needed: Switch to ${modeLabel} Mode`;
        break;
      }
      case 'ask_questions':
        title = 'Questions from AI Instance';
        break;
      case 'approve_action':
        title = 'Approval Needed';
        break;
      default:
        title = 'Input Needed';
        break;
    }
    windowManager.notifyUserActionRequest(
      title,
      request.message || 'An AI instance is waiting for your response.'
    );
  });

  for (const eventName of [
    'repo-job:submitted',
    'repo-job:started',
    'repo-job:progress',
    'repo-job:completed',
    'repo-job:failed',
    'repo-job:cancelled',
  ] as const) {
    repoJobs.on(eventName, (job) => {
      observer.publishRepoJob(job);
    });
  }

  const activityBridge = getOrchestrationActivityBridge();
  activityBridge.initialize(
    windowManager,
    orchestration,
    getDebateCoordinator(),
    getMultiVerifyCoordinator()
  );

  instanceManager.on('instance:created', (instance: Instance) => {
    if (instance.status) previousStatus.set(instance.id, instance.status);
  });

  instanceManager.on('instance:batch-update', (payload: {
    updates?: { instanceId: string; status?: string; contextUsage?: { used: number; total: number; percentage: number } }[]
  }) => {
    if (!payload.updates) return;
    for (const update of payload.updates) {
      // Fire a desktop notification when an instance transitions from an active
      // state to idle/completed. Skip if we haven't seen a previous status yet
      // (startup) to avoid spurious notifications.
      if (update.status) {
        const prev = previousStatus.get(update.instanceId);
        if (prev && ACTIVE_STATUSES.has(prev) && update.status === 'idle') {
          const instance = instanceManager.getInstance(update.instanceId);
          if (instance) {
            getContextEngine().afterTurn({ instance, status: update.status as InstanceStatus });
          }
          const displayName = instance?.displayName ?? update.instanceId;
          windowManager.notifyAgentCompleted(update.instanceId, displayName);
        }
        previousStatus.set(update.instanceId, update.status);
      }
    }
  });

  const memMonitor = getMemoryMonitor();
  memMonitor.on('memory:warning', () => {
    try { setGlobalState({ memoryPressure: 'warning' }); } catch { /* non-critical */ }
  });
  memMonitor.on('memory:critical', () => {
    try { setGlobalState({ memoryPressure: 'critical' }); } catch { /* non-critical */ }
  });
  memMonitor.on('memory:normal', () => {
    try { setGlobalState({ memoryPressure: 'normal' }); } catch { /* non-critical */ }
  });

  getAppStore();
}
