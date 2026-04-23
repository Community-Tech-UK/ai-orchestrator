import { getCompactionCoordinator } from '../context/compaction-coordinator';
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
  addInstance,
  removeInstance,
  setGlobalState,
  updateInstance,
} from '../state';
import type { InstanceSlice } from '../state';
import { getLoadBalancer } from '../process/load-balancer';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { IPC_CHANNELS } from '@contracts/channels';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import type { Instance } from '../../shared/types/instance.types';

const logger = getLogger('InstanceEventForwarding');

export interface InstanceEventForwardingOptions {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
  isStatelessExecProvider: (provider: string | undefined) => boolean;
  getNodeLatencyForInstance: (instanceId: string) => number | undefined;
}

function toSlice(instance: Instance): InstanceSlice {
  return {
    id: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    contextUsage: instance.contextUsage,
    lastActivity: instance.lastActivity,
    provider: instance.provider,
    currentModel: instance.currentModel,
    parentId: instance.parentId,
    childrenIds: instance.childrenIds,
    agentId: instance.agentId,
    workingDirectory: instance.workingDirectory,
    processId: instance.processId,
    errorCount: instance.errorCount,
    totalTokensUsed: instance.totalTokensUsed,
  };
}

export function setupInstanceEventForwarding(options: InstanceEventForwardingOptions): void {
  const { instanceManager, windowManager, isStatelessExecProvider, getNodeLatencyForInstance } = options;
  const observer = getRemoteObserverServer();
  const repoJobs = getRepoJobService();

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
    getCompactionCoordinator().cleanupInstance(instanceId as string);
    getDoomLoopDetector().cleanupInstance(instanceId as string);
    getLoadBalancer().removeMetrics(instanceId as string);
    getWorkflowManager().cleanupInstance(instanceId as string);
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

  instanceManager.on('provider:normalized-event', (envelope) => {
    if (process.env['NODE_ENV'] !== 'production') {
      ProviderRuntimeEventEnvelopeSchema.parse(envelope);
    }

    windowManager.sendToRenderer(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, envelope);
    const message = toOutputMessageFromProviderEnvelope(envelope);
    if (!message) {
      return;
    }

    observer.publishInstanceOutput(envelope.instanceId, message);
    try {
      const continuity = getSessionContinuityManager();
      const instance = instanceManager.getInstance(envelope.instanceId);
      if (instance) {
        const stateUpdate: Parameters<typeof continuity.updateState>[1] = {
          sessionId: instance.sessionId,
          historyThreadId: instance.historyThreadId,
          provider: instance.provider,
          displayName: instance.displayName,
          workingDirectory: instance.workingDirectory,
        };
        if (instance.currentModel) {
          stateUpdate.modelId = instance.currentModel;
        }
        continuity.updateState(envelope.instanceId, stateUpdate);
      }
      if (
        message.type === 'user' ||
        message.type === 'assistant' ||
        message.type === 'tool_use' ||
        message.type === 'tool_result'
      ) {
        continuity.addConversationEntry(envelope.instanceId, {
          id: message.id || `msg-${Date.now()}`,
          role: message.type === 'user' ? 'user' : message.type === 'assistant' ? 'assistant' : 'tool',
          content: message.content || '',
          timestamp: message.timestamp || Date.now(),
        });
      }
    } catch {
      logger.warn('Failed to track conversation entry', { instanceId: envelope.instanceId });
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
      const coordinator = getCompactionCoordinator();
      for (const update of data.updates) {
        if (update.contextUsage) {
          const instance = instanceManager.getInstance(update.instanceId);
          if (isStatelessExecProvider(instance?.provider)) {
            continue;
          }

          coordinator.onContextUpdate(update.instanceId, update.contextUsage);
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
      const continuity = getSessionContinuityManager();
      const loadBalancer = getLoadBalancer();
      for (const update of data.updates) {
        if (update.contextUsage) {
          continuity.updateState(update.instanceId, {
            contextUsage: {
              used: update.contextUsage.used,
              total: update.contextUsage.total,
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
    try { addInstance(toSlice(instance)); } catch { /* store failure must not block main flow */ }
  });

  instanceManager.on('instance:removed', (instanceId: string) => {
    try { removeInstance(instanceId); } catch { /* non-critical */ }
  });

  instanceManager.on('instance:state-update', (update: Record<string, unknown>) => {
    const id = update['instanceId'] as string | undefined;
    if (!id) return;
    const instance = instanceManager.getInstance(id);
    if (!instance) return;
    try { updateInstance(id, toSlice(instance)); } catch { /* non-critical */ }
  });

  instanceManager.on('instance:batch-update', (payload: {
    updates?: { instanceId: string; status?: string; contextUsage?: { used: number; total: number; percentage: number } }[]
  }) => {
    if (!payload.updates) return;
    for (const update of payload.updates) {
      const partial: Partial<InstanceSlice> = {};
      if (update.status) partial.status = update.status as InstanceSlice['status'];
      if (update.contextUsage) partial.contextUsage = update.contextUsage;
      try { updateInstance(update.instanceId, partial); } catch { /* non-critical */ }
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
