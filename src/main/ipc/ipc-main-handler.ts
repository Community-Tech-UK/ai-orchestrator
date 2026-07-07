/**
 * IPC Main Handler - Slim Coordinator
 * Registers all IPC handlers and manages event forwarding
 */

import { IpcMainInvokeEvent, ipcMain } from 'electron';
import * as crypto from 'crypto';
import { getLogger } from '../logging/logger';
import { installIpcHandlerTiming } from './ipc-handler-timing';
import { InstanceManager } from '../instance/instance-manager';
import { WindowManager } from '../window-manager';
import type { IpcResponse } from '../../shared/types/ipc.types';
import { registerOrchestrationHandlers } from './orchestration-ipc-handler';
import { registerVerificationHandlers } from './verification-ipc-handler';
import { registerCliVerificationHandlers } from './cli-verification-ipc-handler';
import { registerLearningHandlers } from './learning-ipc-handler';
import { registerMemoryHandlers } from './memory-ipc-handler';
import { registerSpecialistHandlers } from './specialist-ipc-handler';
import { registerTrainingHandlers } from './training-ipc-handler';
import { registerLLMHandlers } from './llm-ipc-handler';
import { registerObservationHandlers } from './observation-ipc-handler';
import { registerTokenStatsHandlers } from './token-stats-ipc-handler';
import { getRLMDatabase } from '../persistence/rlm-database';
import { OrchestrationEventStore } from '../orchestration/event-store/orchestration-event-store';
import { isFeatureEnabled } from '../../shared/constants/feature-flags';
import { registerDefaultQuotaProbes } from '../core/system/provider-quota';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { getPromptHistoryService } from '../prompt-history/prompt-history-service';
import {
  registerMemoryStatsHandlers,
  serializeInstanceForIpc,
  setupIpcEventForwarding,
} from './ipc-main-runtime-wiring';
import { registerStateResyncHandler } from '../event-bus/state-resync-ipc-handler';
import { buildStateSyncSnapshot } from '../event-bus/state-sync-snapshot';
import { createThinClientCommandExecutor } from '../event-bus/thin-client-command-executor';
import { initializeThinClientWsServer } from '../event-bus/thin-client-ws-server';

// Import extracted handlers
import {
  registerInstanceHandlers,
  registerSettingsHandlers,
  registerInstructionHandlers,
  registerSessionHandlers,
  registerProviderHandlers,
  registerVcsHandlers,
  registerLspHandlers,
  registerSnapshotHandlers,
  registerMcpHandlers,
  registerBrowserGatewayHandlers,
  registerBrowserUnattendedHandlers,
  registerTodoHandlers,
  registerSecurityHandlers,
  registerDebugHandlers,
  registerCostHandlers,
  registerQuotaHandlers,
  registerTaskHandlers,
  registerRepoJobHandlers,
  registerSearchHandlers,
  registerStatsHandlers,
  registerCommandHandlers,
  registerMagicPromptHandlers,
  registerCompareHandlers,
  registerUpdateHandlers,
  registerPromptHistoryHandlers,
  registerPauseHandlers,
  registerHistorySearchHandlers,
  registerResumeHandlers,
  registerWorkflowHandlers,
  registerDiagnosticsHandlers,
  bridgeCliUpdatePillDeltaToWindow,
  registerAppHandlers,
  registerFileHandlers,
  registerCodebaseHandlers,
  registerWorkspaceHintHandlers,
  registerEventStoreHandlers,
  registerSupervisionHandlers,
  registerRecentDirectoriesHandlers,
  registerEcosystemHandlers,
  registerConsensusHandlers,
  registerRoutingHandlers,
  registerCommunicationHandlers,
  registerParallelWorktreeHandlers,
  registerRemoteObserverHandlers,
  registerRemoteNodeHandlers,
  registerImageHandlers,
  registerChannelHandlers,
  registerReactionHandlers,
  registerRemoteFsHandlers,
  registerMobileGatewayHandlers,
  registerKnowledgeGraphHandlers,
  registerConversationMiningHandlers,
  registerWakeContextHandlers,
  registerAutomationHandlers,
  registerWebhookHandlers,
  registerVoiceHandlers,
  registerConversationLedgerHandlers,
  registerChatHandlers,
  registerOperatorHandlers,
  registerRuntimePluginHandlers,
  registerProjectPluginTrustHandlers,
  registerRtkHandlers,
  registerLoopHandlers,
  registerTerminalHandlers,
  registerAuxiliaryLlmHandlers,
  registerCampaignHandlers,
} from './handlers';
import { registerLspFeedback } from '../codemem/lsp-feedback-registration';
import { registerCircuitBreaker } from '../security/circuit-breaker-registration';
import { getCostTracker } from '../core/system/cost-tracker';

const logger = getLogger('IpcMainHandler');

export class IpcMainHandler {
  private instanceManager: InstanceManager;
  private windowManager: WindowManager;
  private ipcAuthToken: string;

  constructor(instanceManager: InstanceManager, windowManager: WindowManager) {
    this.instanceManager = instanceManager;
    this.windowManager = windowManager;
    this.ipcAuthToken = crypto.randomUUID();
  }

  private ensureTrustedSender(
    event: IpcMainInvokeEvent,
    channel: string
  ): IpcResponse | null {
    const mainWindow = this.windowManager.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return {
        success: false,
        error: {
          code: 'IPC_TRUST_FAILED',
          message: `No trusted window available for ${channel}`,
          timestamp: Date.now()
        }
      };
    }

    if (event.sender.id !== mainWindow.webContents.id) {
      return {
        success: false,
        error: {
          code: 'IPC_TRUST_FAILED',
          message: `Untrusted sender for ${channel}`,
          timestamp: Date.now()
        }
      };
    }

    const url = event.senderFrame?.url || event.sender.getURL();
    const isAllowedUrl =
      url.startsWith('file://') || url.startsWith('http://localhost:');
    if (url && !isAllowedUrl) {
      return {
        success: false,
        error: {
          code: 'IPC_TRUST_FAILED',
          message: `Untrusted origin for ${channel}: ${url}`,
          timestamp: Date.now()
        }
      };
    }

    return null;
  }

  private ensureAuthorized(
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ): IpcResponse | null {
    const trustError = this.ensureTrustedSender(event, channel);
    if (trustError) return trustError;

    const authPayload = payload as { ipcAuthToken?: string } | undefined;
    if (!authPayload?.ipcAuthToken || authPayload.ipcAuthToken !== this.ipcAuthToken) {
      return {
        success: false,
        error: {
          code: 'IPC_AUTH_FAILED',
          message: `Missing or invalid auth token for ${channel}`,
          timestamp: Date.now()
        }
      };
    }

    return null;
  }

  /**
   * Register all IPC handlers
   */
  registerHandlers(): void {
    // Instrument every handler registered below with synchronous-prelude timing
    // so any handler that blocks the main event loop is logged loudly. Must run
    // before the first registerXxxHandlers() call.
    installIpcHandlerTiming(ipcMain);

    // Instance management handlers
    registerInstanceHandlers({
      instanceManager: this.instanceManager,
      windowManager: this.windowManager
    });

    // App handlers
    registerAppHandlers({
      windowManager: this.windowManager,
      getIpcAuthToken: () => this.ipcAuthToken
    });
    registerStateResyncHandler({
      instanceManager: this.instanceManager,
      ensureAuthorized: this.ensureAuthorized.bind(this),
      getSeq: () => this.windowManager.getRendererSnapshotSeq(),
    });
    initializeThinClientWsServer({
      getIpcAuthToken: () => this.ipcAuthToken,
      buildStateSnapshot: (seq) => buildStateSyncSnapshot({
        instanceManager: this.instanceManager,
        getSeq: () => seq,
      }),
      executeCommand: createThinClientCommandExecutor({
        instanceManager: this.instanceManager,
      }),
    });

    if (isFeatureEnabled('EVENT_SOURCING')) {
      const getEventStore = () => {
        const store = OrchestrationEventStore.getInstance(getRLMDatabase().getRawDb());
        store.initialize();
        return store;
      };
      registerEventStoreHandlers({
        getByAggregateId: (aggregateId) => getEventStore().getByAggregateId(aggregateId),
        getByType: (type, limit) => getEventStore().getByType(type as never, limit),
        getRecentEvents: (limit) => getEventStore().getRecentEvents(limit),
      });
    } else {
      logger.info('Event store IPC handlers skipped because EVENT_SOURCING is disabled');
    }

    // Settings, config, and remote config handlers
    registerSettingsHandlers({ windowManager: this.windowManager });
    registerPauseHandlers({ windowManager: this.windowManager });
    registerInstructionHandlers();

    // Memory stats handlers (basic memory tracking)
    registerMemoryStatsHandlers(this.instanceManager);

    // Session, archive, and history handlers
    registerSessionHandlers({
      instanceManager: this.instanceManager,
      serializeInstance: serializeInstanceForIpc,
    });

    // Provider and plugin handlers
    registerProviderHandlers({
      windowManager: this.windowManager,
      ensureAuthorized: this.ensureAuthorized.bind(this)
    });

    // Command and plan mode handlers
    registerCommandHandlers(this.instanceManager);
    registerMagicPromptHandlers();
    registerCompareHandlers();
    registerLspFeedback({ instanceManager: this.instanceManager });
    registerCircuitBreaker({ costTracker: getCostTracker() });
    registerUpdateHandlers({ windowManager: this.windowManager });
    getPromptHistoryService().pruneOnStart();
    registerPromptHistoryHandlers({ windowManager: this.windowManager });
    registerHistorySearchHandlers();
    registerResumeHandlers({ instanceManager: this.instanceManager });
    registerWorkflowHandlers();
    registerDiagnosticsHandlers();

    // RTK token-savings panel
    registerRtkHandlers();

    // Auxiliary LLM (local/cheap-model routing for helper calls)
    registerAuxiliaryLlmHandlers();

    // Loop Mode (autonomous fix→verify→fix loop)
    registerLoopHandlers({
      windowManager: this.windowManager,
      instanceManager: this.instanceManager,
    });

    // VCS handlers (Git integration). windowManager is required for the
    // VCS_STATUS_CHANGED event push from GitStatusWatcher.
    registerVcsHandlers({ windowManager: this.windowManager });

    // Snapshot handlers (File revert)
    registerSnapshotHandlers();

    // TODO handlers
    registerTodoHandlers({ windowManager: this.windowManager });

    // MCP handlers
    registerMcpHandlers({ windowManager: this.windowManager });
    registerBrowserGatewayHandlers({
      ensureTrustedSender: this.ensureTrustedSender.bind(this),
      instanceManager: this.instanceManager,
    });
    // Unattended-layer trigger surfaces (vault unlock, credential
    // authorizations, campaigns, escalation triage) — renderer-only.
    registerBrowserUnattendedHandlers({
      ensureTrustedSender: this.ensureTrustedSender.bind(this),
    });

    // LSP handlers
    registerLspHandlers();

    // File handlers (editor, watcher, multi-edit)
    registerFileHandlers({ windowManager: this.windowManager });

    // Image handlers (clipboard copy, context menu)
    registerImageHandlers();

    // Task management handlers (subagent spawning)
    registerTaskHandlers();
    registerRepoJobHandlers(this.instanceManager);

    // Security handlers (secret detection, env filtering, bash validation)
    registerSecurityHandlers();

    // Cost tracking handlers
    registerCostHandlers({ windowManager: this.windowManager });

    // Provider quota handlers (remaining usage budgets per CLI provider).
    // Probes must be registered BEFORE the handlers so that the first
    // QUOTA_REFRESH IPC call has them available.
    registerDefaultQuotaProbes();
    registerQuotaHandlers({ windowManager: this.windowManager });
    // Low-frequency idle poll (60s) keeps usage windows fresh even when no
    // loop/adapter activity is driving refreshes, so the throttle ladder can
    // react to ">=90%" before a loop spills into paid overage. Gated by the
    // pause-coordinator inside the service; the timer is unref'd.
    getProviderQuotaService().startIdleRefresh(60_000);

    // Debug command handlers
    registerDebugHandlers();

    // Usage stats handlers
    registerStatsHandlers();

    // Semantic search handlers
    registerSearchHandlers();

    // Codebase indexing handlers
    registerCodebaseHandlers(this.windowManager);

    // Unified workspace hint handler. Fans `WORKSPACE_HINT_ACTIVE` (called from
    // the renderer whenever the active workspace changes) out to every
    // coordinator that subscribes to "workspace is present" events. The
    // coordinators must already be initialized in initialization-steps.ts
    // before the hint can do anything useful — if a coordinator isn't ready
    // the fan-out is a no-op for it (best-effort).
    registerWorkspaceHintHandlers();

    // Orchestration handlers (Phase 6: Workflows, Hooks, Skills)
    registerOrchestrationHandlers(this.instanceManager);

    // Ecosystem handlers (file-based commands/agents/tools/plugins)
    registerEcosystemHandlers(this.instanceManager);

    // Verification handlers (Worktree, Verification, Supervision)
    registerVerificationHandlers();

    // CLI Verification handlers (Multi-CLI detection and verification)
    registerCliVerificationHandlers({
      windowManager: this.windowManager,
      ensureAuthorized: this.ensureAuthorized.bind(this)
    });

    // Learning handlers (RLM Context, Self-Improvement, Model Discovery)
    registerLearningHandlers();

    // Memory handlers (Memory-R1, Unified Memory, Debate, Training)
    registerMemoryHandlers();

    // Specialist handlers (Phase 7.4: Specialist Profiles)
    registerSpecialistHandlers();

    // Training handlers (GRPO Dashboard)
    registerTrainingHandlers();

    // LLM handlers (streaming and token counting)
    registerLLMHandlers();

    // Supervision handlers (Phase 2: Hierarchical Instances)
    registerSupervisionHandlers();

    // Observation memory handlers
    registerObservationHandlers();

    // Token stats handlers (lightweight token usage tracking)
    registerTokenStatsHandlers();

    // Recent directories handlers
    registerRecentDirectoriesHandlers();

    // Consensus handlers (multi-model consensus queries)
    registerConsensusHandlers();

    // Routing handlers (model routing and hot model switching)
    registerRoutingHandlers();

    // Communication handlers (cross-instance bridges and messaging)
    registerCommunicationHandlers();

    // Parallel worktree handlers (parallel execution coordination)
    registerParallelWorktreeHandlers();

    // Remote observer handlers (read-only local web observer)
    registerRemoteObserverHandlers();

    // Remote node handlers (worker node management)
    registerRemoteNodeHandlers();

    // Remote terminal handlers (interactive PTY on a worker node — Piece C)
    registerTerminalHandlers({ windowManager: this.windowManager });

    // Remote filesystem handlers (read-dir, stat, search, watch, unwatch)
    registerRemoteFsHandlers();

    // Mobile gateway handlers (phone control app — start/stop, pairing, devices)
    registerMobileGatewayHandlers();

    // Channel handlers (Discord/WhatsApp messaging)
    registerChannelHandlers();

    // Reaction engine handlers (CI/PR monitoring)
    registerReactionHandlers({ windowManager: this.windowManager });

    // Campaign mode handlers (DAG of loop specs)
    registerCampaignHandlers({ windowManager: this.windowManager });

    // Knowledge graph handlers (fact/entity CRUD and queries)
    registerKnowledgeGraphHandlers();

    // Conversation mining handlers (import and format detection)
    registerConversationMiningHandlers();

    // Wake context handlers (wake-up context generation and hints)
    registerWakeContextHandlers();

    // Automation handlers (scheduled prompt runs)
    registerAutomationHandlers();
    registerWebhookHandlers();
    registerVoiceHandlers({
      ensureAuthorized: this.ensureAuthorized.bind(this)
    });
    registerConversationLedgerHandlers();
    registerChatHandlers({ instanceManager: this.instanceManager });
    registerOperatorHandlers();
    registerRuntimePluginHandlers();
    registerProjectPluginTrustHandlers();

    // Set up event forwarding to renderer
    setupIpcEventForwarding({
      instanceManager: this.instanceManager,
      windowManager: this.windowManager,
    });
    bridgeCliUpdatePillDeltaToWindow(this.windowManager);

    logger.info('IPC handlers registered');
  }

}
