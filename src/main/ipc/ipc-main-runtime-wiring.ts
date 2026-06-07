import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { validateIpcPayload } from '@contracts/schemas/common';
import { MemoryLoadHistoryPayloadSchema } from '@contracts/schemas/instance';
import { IPC_CHANNELS } from '@contracts/channels';
import { getLogger } from '../logging/logger';
import { RLMContextManager } from '../rlm/context-manager';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getTrainingLoop } from '../memory/training-loop';
import { getHotModelSwitcher } from '../routing/hot-model-switcher';
import { getChannelManager } from '../channels';
import { getReactionEngine } from '../reactions';
import { getKnowledgeGraphService } from '../memory/knowledge-graph-service';
import { getConversationMiner } from '../memory/conversation-miner';
import { getWakeContextBuilder } from '../memory/wake-context-builder';
import { getAutomationEvents } from '../automations/automation-events';
import type { IpcResponse } from '../../shared/types/ipc.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import {
  isHighVolumeContextStore,
  serializeContextSectionForIpc,
  serializeContextStoreForIpc,
} from './rlm-ipc-serialization';

const logger = getLogger('IpcMainHandler');

export interface IpcRuntimeWiringDeps {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
}

export function registerMemoryStatsHandlers(instanceManager: InstanceManager): void {
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: instanceManager.getMemoryStats(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MEMORY_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_LOAD_HISTORY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(MemoryLoadHistoryPayloadSchema, payload, 'MEMORY_LOAD_HISTORY');
        const messages = await instanceManager.loadHistoricalOutput(
          validated.instanceId,
          validated.limit,
        );
        return {
          success: true,
          data: messages,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'LOAD_HISTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}

export function setupIpcEventForwarding(deps: IpcRuntimeWiringDeps): void {
  setupMemoryEventForwarding(deps);
  setupRlmEventForwarding(deps.windowManager);
  setupDebateEventForwarding(deps.windowManager);
  setupVerificationEventForwarding(deps.windowManager);
  setupTrainingEventForwarding(deps.windowManager);
  setupHotSwitchEventForwarding(deps.windowManager);
  setupChannelEventForwarding(deps.windowManager);
  setupReactionEventForwarding(deps.windowManager);
  setupKnowledgeEventForwarding(deps.windowManager);
  setupAutomationEventForwarding(deps.windowManager);
}

export function serializeInstanceForIpc(instance: unknown): Record<string, unknown> {
  const record = (
    typeof instance === 'object' && instance !== null
      ? { ...(instance as Record<string, unknown>) }
      : {}
  ) as Record<string, unknown>;
  const communicationTokens = record['communicationTokens'];
  delete record['readyPromise'];
  delete record['respawnPromise'];
  delete record['abortController'];

  return {
    ...record,
    communicationTokens:
      communicationTokens instanceof Map
        ? Object.fromEntries(communicationTokens)
        : communicationTokens,
  };
}

function setupAutomationEventForwarding(windowManager: WindowManager): void {
  const events = getAutomationEvents();
  events.on('automation:changed', (event) => {
    windowManager.sendToRenderer(IPC_CHANNELS.AUTOMATION_CHANGED, event);
  });
  events.on('automation:run-changed', (event) => {
    windowManager.sendToRenderer(IPC_CHANNELS.AUTOMATION_RUN_CHANGED, event);
  });
}

function setupMemoryEventForwarding({ instanceManager, windowManager }: IpcRuntimeWiringDeps): void {
  instanceManager.on('memory:stats', (stats) => {
    windowManager.sendToRenderer(IPC_CHANNELS.MEMORY_STATS_UPDATE, stats);
  });

  instanceManager.on('memory:warning', (stats) => {
    windowManager.sendToRenderer(IPC_CHANNELS.MEMORY_WARNING, {
        ...stats,
        message: `Memory usage warning: ${stats.heapUsedMB}MB heap used`,
    });
  });

  instanceManager.on('memory:critical', (stats) => {
    windowManager.sendToRenderer(IPC_CHANNELS.MEMORY_CRITICAL, {
        ...stats,
        message: `Critical memory usage: ${stats.heapUsedMB}MB heap used. Idle instances may be terminated.`,
    });
  });
}

function setupRlmEventForwarding(windowManager: WindowManager): void {
  const rlm = RLMContextManager.getInstance();

  rlm.on('store:created', (store) => {
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_STORE_UPDATED, {
        storeId: store.id,
        store: serializeContextStoreForIpc(store),
    });
  });

  rlm.on('section:added', ({ store, section }) => {
    if (isHighVolumeContextStore(store)) {
      return;
    }
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_SECTION_ADDED, {
        storeId: store.id,
        section: serializeContextSectionForIpc(section),
    });
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_STORE_UPDATED, {
        storeId: store.id,
        store: serializeContextStoreForIpc(store, {
          includeSections: true,
          sectionLimit: 500,
        }),
    });
  });

  rlm.on('section:removed', ({ store, section }) => {
    if (isHighVolumeContextStore(store)) {
      return;
    }
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_SECTION_REMOVED, {
        storeId: store.id,
        sectionId: section.id,
    });
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_STORE_UPDATED, {
        storeId: store.id,
        store: serializeContextStoreForIpc(store, {
          includeSections: true,
          sectionLimit: 500,
        }),
    });
  });

  rlm.on('query:executed', ({ session, queryResult }) => {
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_QUERY_COMPLETE, {
        sessionId: session.id,
        queryResult,
    });
  });

  rlm.on('summary:created', ({ storeId, section }) => {
    windowManager.sendToRenderer(IPC_CHANNELS.RLM_SECTION_ADDED, {
        storeId,
        section: serializeContextSectionForIpc(section),
    });
  });
}

function setupDebateEventForwarding(windowManager: WindowManager): void {
  try {
    const debate = getDebateCoordinator();
    const send = (channel: string, data: unknown) =>
      windowManager.sendToRenderer(channel, data);

    debate.on('debate:started', (data) => send(IPC_CHANNELS.DEBATE_EVENT_STARTED, data));
    debate.on('debate:round-complete', (data) => send(IPC_CHANNELS.DEBATE_EVENT_ROUND_COMPLETE, data));
    debate.on('debate:completed', (data) => send(IPC_CHANNELS.DEBATE_EVENT_COMPLETED, data));
    debate.on('debate:error', (data) => send(IPC_CHANNELS.DEBATE_EVENT_ERROR, data));
    debate.on('debate:paused', (data) => send(IPC_CHANNELS.DEBATE_EVENT_PAUSED, data));
    debate.on('debate:resumed', (data) => send(IPC_CHANNELS.DEBATE_EVENT_RESUMED, data));
  } catch {
    logger.warn('DebateCoordinator not available for event forwarding');
  }
}

function setupVerificationEventForwarding(windowManager: WindowManager): void {
  try {
    const verify = getMultiVerifyCoordinator();
    const send = (channel: string, data: unknown) =>
      windowManager.sendToRenderer(channel, data);

    verify.on('verification:started', (data) => send(IPC_CHANNELS.VERIFICATION_EVENT_STARTED, data));
    verify.on('verification:progress', (data) => send(IPC_CHANNELS.VERIFICATION_EVENT_PROGRESS, data));
    verify.on('verification:completed', (data) => send(IPC_CHANNELS.VERIFICATION_EVENT_COMPLETED, data));
    verify.on('verification:error', (data) => send(IPC_CHANNELS.VERIFICATION_EVENT_ERROR, data));
  } catch {
    logger.warn('MultiVerifyCoordinator not available for event forwarding');
  }
}

function setupTrainingEventForwarding(windowManager: WindowManager): void {
  try {
    const training = getTrainingLoop();
    const send = (channel: string, data: unknown) =>
      windowManager.sendToRenderer(channel, data);

    training.on('training:started', (data) => send(IPC_CHANNELS.TRAINING_EVENT_STARTED, data));
    training.on('training:completed', (data) => send(IPC_CHANNELS.TRAINING_EVENT_COMPLETED, data));
    training.on('training:error', (data) => send(IPC_CHANNELS.TRAINING_EVENT_ERROR, data));
  } catch {
    logger.warn('TrainingLoop not available for event forwarding');
  }
}

function setupHotSwitchEventForwarding(windowManager: WindowManager): void {
  try {
    const switcher = getHotModelSwitcher();
    const send = (channel: string, data: unknown) =>
      windowManager.sendToRenderer(channel, data);

    switcher.on('switch:started', (data) => send(IPC_CHANNELS.HOT_SWITCH_EVENT_STARTED, data));
    switcher.on('switch:completed', (data) => send(IPC_CHANNELS.HOT_SWITCH_EVENT_COMPLETED, data));
    switcher.on('switch:failed', (data) => send(IPC_CHANNELS.HOT_SWITCH_EVENT_FAILED, data));
  } catch {
    logger.warn('HotModelSwitcher not available for event forwarding');
  }
}

function setupChannelEventForwarding(windowManager: WindowManager): void {
  const channelManager = getChannelManager();

  channelManager.onEvent((event) => {
    switch (event.type) {
      case 'status':
        windowManager.sendToRenderer(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, event.data);
        break;
      case 'message':
        windowManager.sendToRenderer(IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED, event.data);
        break;
      case 'error':
        windowManager.sendToRenderer(IPC_CHANNELS.CHANNEL_ERROR, event.data);
        break;
      case 'response-sent':
        windowManager.sendToRenderer(IPC_CHANNELS.CHANNEL_RESPONSE_SENT, event.data);
        break;
    }
  });
}

function setupReactionEventForwarding(windowManager: WindowManager): void {
  const engine = getReactionEngine();

  engine.on('reaction:event', (event: unknown) => {
    windowManager.sendToRenderer(IPC_CHANNELS.REACTION_EVENT, event);
  });

  engine.on('reaction:escalated', (event: unknown) => {
    windowManager.sendToRenderer(IPC_CHANNELS.REACTION_ESCALATED, event);
  });
}

function setupKnowledgeEventForwarding(windowManager: WindowManager): void {
  try {
    const kg = getKnowledgeGraphService();
    const miner = getConversationMiner();
    const wake = getWakeContextBuilder();
    const send = (channel: string, data: unknown) =>
      windowManager.sendToRenderer(channel, data);

    kg.on('graph:fact-added', (data) => send(IPC_CHANNELS.KG_EVENT_FACT_ADDED, data));
    kg.on('graph:fact-invalidated', (data) => send(IPC_CHANNELS.KG_EVENT_FACT_INVALIDATED, data));
    miner.on('miner:import-complete', (data) => send(IPC_CHANNELS.CONVO_EVENT_IMPORT_COMPLETE, data));
    wake.on('wake:hint-added', (data) => send(IPC_CHANNELS.WAKE_EVENT_HINT_ADDED, data));
    wake.on('wake:context-generated', (data) => send(IPC_CHANNELS.WAKE_EVENT_CONTEXT_GENERATED, data));
  } catch {
    logger.warn('Knowledge services not available for event forwarding');
  }
}
