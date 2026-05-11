import { app } from 'electron';
import { getSettingsManager } from '../core/config/settings-manager';
import { getHookManager } from '../hooks/hook-manager';
import {
  registerDefaultMultiVerifyInvoker,
  registerDefaultReviewInvoker,
  registerDefaultDebateInvoker,
  registerDefaultWorkflowInvoker,
  registerDefaultLoopInvoker,
} from '../orchestration/default-invokers';
import { getLoopStoreService } from '../orchestration/loop-store';
import { getOrchestratorPluginManager } from '../plugins/plugin-manager';
import { getObservationIngestor, getObserverAgent, getReflectorAgent } from '../observation';
import { initializePathValidator } from '../security/path-validator';
import { getLogger } from '../logging/logger';
import { initTruncationCleanup } from '../util/tool-output-truncation';
import { getRemoteObserverServer } from '../remote/observer-server';
import { getSessionContinuityManager } from '../session/session-continuity';
import { registerCompactionSummaryRenderer } from '../display-items/compaction-summary-renderer';
import { getResourceGovernor } from '../process/resource-governor';
import { getHibernationManager } from '../process/hibernation-manager';
import { getPoolManager } from '../process/pool-manager';
import { getLoadBalancer } from '../process/load-balancer';
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  handleNodeFailover,
  handleLateNodeReconnect,
  RpcEventRouter,
  getRemoteNodeConfig,
  hydrateRemoteNodeConfig,
} from '../remote-node';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
import { registerCrossModelReviewIpcHandlers } from '../ipc/cross-model-review-ipc';
import {
  getChannelManager,
  ChannelMessageRouter,
  ChannelPersistence,
  ChannelCredentialStore,
  ChannelAccessPolicyStore,
  restoreSavedAccessPolicy,
} from '../channels';
import { getRLMDatabase } from '../persistence/rlm-database';
import { bootstrapAll } from '../bootstrap';
import { registerOrchestrationBootstrap } from '../bootstrap/orchestration-bootstrap';
import { registerLearningBootstrap } from '../bootstrap/learning-bootstrap';
import { registerMemoryBootstrap } from '../bootstrap/memory-bootstrap';
import { registerInfrastructureBootstrap } from '../bootstrap/infrastructure-bootstrap';
import { getKnowledgeBridge } from '../memory/knowledge-bridge';
import { getChildAnnouncer } from '../orchestration/child-announcer';
import type { ChildAnnouncement } from '../../shared/types/child-announce.types';
import { getAgentTreePersistence } from '../session/agent-tree-persistence';
import { getPermissionRegistry } from '../orchestration/permission-registry';
import { getOrchestrationSnapshotManager } from '../orchestration/orchestration-snapshot';
import { getReactionEngine } from '../reactions';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { getPermissionManager } from '../security/permission-manager';
import { PermissionDecisionStore } from '../security/permission-decision-store';
import { WorkflowPersistence } from '../workflows/workflow-persistence';
import { initializeCodemem, getCodemem } from '../codemem';
import { initializeAutomations } from '../automations';
import { initializeBrowserGatewayRuntime } from '../browser-gateway';
import { installRuntimeDiagnostics } from './runtime-diagnostics';
import { setupCompactionCoordinator } from './compaction-runtime';
import { setupInstanceEventForwarding } from './instance-event-forwarding';
import { initializePauseFeatureRuntime } from './pause-feature-bootstrap';
import { initializeMainProcessWatchdog } from '../runtime/main-process-watchdog';
import { getEventLoopLagMonitor } from '../runtime/event-loop-lag-monitor';
import { getContextWorkerClient } from '../instance/context-worker-client';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';

const logger = getLogger('AppInitialization');

export interface AppInitializationStep {
  name: string;
  critical?: boolean;
  fn: () => Promise<void> | void;
}

export interface AppInitializationContext {
  instanceManager: InstanceManager;
  windowManager: WindowManager;
  isStatelessExecProvider: (provider: string | undefined) => boolean;
  getNodeLatencyForInstance: (instanceId: string) => number | undefined;
  syncRemoteNodeMetricsToLoadBalancer: (nodeId: string) => void;
}

export function createInitializationSteps(
  context: AppInitializationContext,
): AppInitializationStep[] {
  const { instanceManager, windowManager } = context;

  return [
    {
      name: 'Conversation ledger',
      fn: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getConversationLedgerService } = require('../conversation-ledger') as typeof import('../conversation-ledger');
          getConversationLedgerService();
        } catch (error) {
          logger.warn('Conversation ledger initialization failed; IPC handlers will report degraded errors', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Operator database',
      fn: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getOperatorDatabase } = require('../operator') as typeof import('../operator');
          getOperatorDatabase();
        } catch (error) {
          logger.warn('Operator database initialization failed; operator IPC handlers will report degraded errors', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Chat service',
      fn: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getChatService } = require('../chats') as typeof import('../chats');
          getChatService({ instanceManager }).initialize();
        } catch (error) {
          logger.warn('Chat service initialization failed; chat IPC handlers will report degraded errors', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Operator event relay',
      fn: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getOperatorEventRelay } = require('../operator') as typeof import('../operator');
          getOperatorEventRelay().start();
        } catch (error) {
          logger.warn('Operator event relay initialization failed; run events will refresh on manual reload only', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'IPC handlers',
      critical: true,
      fn: () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { IpcMainHandler } = require('../ipc/ipc-main-handler') as typeof import('../ipc/ipc-main-handler');
        const ipcHandler = new IpcMainHandler(instanceManager, windowManager);
        ipcHandler.registerHandlers();
      },
    },
    { name: 'Runtime diagnostics', fn: () => installRuntimeDiagnostics() },
    {
      name: 'Main process watchdog',
      fn: () => {
        const lagMonitor = getEventLoopLagMonitor();
        lagMonitor.start();
        const watchdog = initializeMainProcessWatchdog({
          userDataPath: app.getPath('userData'),
          appVersion: app.getVersion(),
          metricsProvider: {
            getEventLoopLagP95Ms: () => lagMonitor.snapshot().p95Ms,
            getEventLoopLagMaxMs: () => lagMonitor.snapshot().maxMs,
            getProviderBusEmitted: () => instanceManager.getProviderEventBusMetrics().emitted,
            getProviderBusDroppedStatus: () => instanceManager.getProviderEventBusMetrics().droppedStatus,
            getContextWorkerInFlight: () => { try { return getContextWorkerClient().getMetrics().inFlight; } catch { return 0; } },
            getContextWorkerDegraded: () => { try { return getContextWorkerClient().getMetrics().degraded; } catch { return false; } },
            getIndexWorkerInFlight: () => { try { return getCodemem().indexWorkerGateway.getMetrics().inFlight; } catch { return 0; } },
            getIndexWorkerDegraded: () => { try { return getCodemem().indexWorkerGateway.getMetrics().degraded; } catch { return false; } },
            getActiveInstanceCount: () => instanceManager.getAllInstances().filter((i) => i.status !== 'terminated').length,
          },
        });
        watchdog.start();
      },
    },
    { name: 'Pause feature', fn: () => initializePauseFeatureRuntime() },
    { name: 'Hook approvals', fn: () => getHookManager().loadApprovals() },
    {
      name: 'Remote observer',
      fn: () => getRemoteObserverServer().initialize({ instanceManager }),
    },
    {
      name: 'Event forwarding',
      critical: true,
      fn: () => setupInstanceEventForwarding({
        instanceManager,
        windowManager,
        isStatelessExecProvider: context.isStatelessExecProvider,
        getNodeLatencyForInstance: context.getNodeLatencyForInstance,
      }),
    },
    { name: 'Verification invokers', fn: () => registerDefaultMultiVerifyInvoker(instanceManager) },
    { name: 'Automations', fn: () => initializeAutomations(instanceManager) },
    { name: 'Review invokers', fn: () => registerDefaultReviewInvoker(instanceManager) },
    { name: 'Debate invokers', fn: () => registerDefaultDebateInvoker(instanceManager) },
    { name: 'Workflow invokers', fn: () => registerDefaultWorkflowInvoker(instanceManager) },
    {
      name: 'Loop store',
      fn: () => {
        try {
          const service = getLoopStoreService();
          // Mark any "running" loops as paused on boot so the user can review.
          const interrupted = service.store.markRunningAsInterruptedOnBoot();
          if (interrupted > 0) {
            logger.info(`Loop store: marked ${interrupted} previously-running loop(s) as paused on boot`);
          }
        } catch (error) {
          logger.warn('Loop store initialization failed; Loop Mode IPC will report degraded errors', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    { name: 'Loop invokers', fn: () => registerDefaultLoopInvoker(instanceManager) },
    {
      name: 'Child auto-announce',
      fn: () => {
        const childAnnouncer = getChildAnnouncer();
        childAnnouncer.on(
          'child:announced',
          (parentId: string, announcements: ChildAnnouncement[], message: string) => {
            const parent = instanceManager.getInstance(parentId);
            if (parent && parent.status !== 'terminated') {
              instanceManager.sendInput(parentId, message).catch((err) => {
                logger.warn('Failed to deliver child announcement to parent', {
                  parentId,
                  childIds: announcements.map((announcement) => announcement.childId),
                  batchSize: announcements.length,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          },
        );
      },
    },
    { name: 'Plugin manager', fn: () => getOrchestratorPluginManager().initialize(instanceManager) },
    { name: 'Reaction engine', fn: () => getReactionEngine().initialize(instanceManager) },
    { name: 'Observation ingestor', fn: () => getObservationIngestor().initialize(instanceManager) },
    { name: 'Observer agent', fn: () => { getObserverAgent(); } },
    { name: 'Reflector agent', fn: () => { getReflectorAgent(); } },
    { name: 'Path validator', fn: () => initializePathValidator() },
    {
      name: 'Compaction coordinator',
      fn: () => setupCompactionCoordinator(instanceManager, windowManager),
    },
    { name: 'Truncation cleanup', fn: () => { initTruncationCleanup(); } },
    {
      name: 'Resource governor',
      fn: () => {
        getResourceGovernor().start({
          getInstanceManager: () => instanceManager,
        });
      },
    },
    {
      name: 'Hibernation manager',
      fn: () => {
        const hibernation = getHibernationManager();
        hibernation.start();
        hibernation.on('check-idle', () => {
          const instances = instanceManager.getAllInstances()
            .filter((instance) => instance.status === 'idle' && instance.parentId)
            .map((instance) => ({
              id: instance.id,
              status: instance.status,
              lastActivity: instance.lastActivity,
            }));
          const candidates = hibernation.getHibernationCandidates(instances);
          for (const candidate of candidates) {
            instanceManager.terminateInstance(candidate.id, true).catch((err) => {
              logger.warn('Failed to terminate idle child instance', {
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }
        });
      },
    },
    {
      name: 'Instance pool',
      fn: () => {
        const pool = getPoolManager();
        pool.start();
        pool.on('instance:evicted', ({ instanceId }: { instanceId: string }) => {
          instanceManager.terminateInstance(instanceId, true).catch((err) => {
            logger.warn('Failed to terminate instance', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        });
      },
    },
    { name: 'Load balancer', fn: () => { getLoadBalancer(); } },
    {
      name: 'Worker node subsystem',
      fn: async () => {
        hydrateRemoteNodeConfig(getSettingsManager().getAll());
        const config = getRemoteNodeConfig();
        if (!config.enabled) {
          logger.info('Remote node subsystem disabled');
          return;
        }

        const registry = getWorkerNodeRegistry();
        const connection = getWorkerNodeConnectionServer();
        const rpcRouter = new RpcEventRouter(connection, registry);
        rpcRouter.start();

        registry.on('node:disconnected', (node) => {
          const nodeId = typeof node === 'string' ? node : node.id;
          handleNodeFailover(nodeId, instanceManager);
          context.syncRemoteNodeMetricsToLoadBalancer(nodeId);
        });

        registry.on('node:connected', (node) => {
          windowManager.sendToRenderer('remote-node:event', { type: 'connected', node });
          const nodeId = typeof node === 'string' ? node : node.id;
          handleLateNodeReconnect(nodeId, instanceManager);
        });
        registry.on('node:disconnected', (node) => {
          windowManager.sendToRenderer('remote-node:event', {
            type: 'disconnected',
            nodeId: typeof node === 'string' ? node : node.id,
          });
        });
        registry.on('node:updated', (node) => {
          context.syncRemoteNodeMetricsToLoadBalancer(node.id);
          windowManager.sendToRenderer('remote-node:event', { type: 'updated', node });
        });

        await connection.start(config.serverPort, config.serverHost);
        logger.info('Worker node subsystem started', {
          port: config.serverPort,
          host: config.serverHost,
        });
      },
    },
    {
      name: 'Cross-model review',
      fn: async () => {
        const crossModelReview = getCrossModelReviewService();
        crossModelReview.setInstanceManager(instanceManager);
        await crossModelReview.initialize();
        registerCrossModelReviewIpcHandlers();
      },
    },
    {
      name: 'Session continuity wiring',
      fn: () => {
        const continuity = getSessionContinuityManager();
        continuity.setInstanceManager(instanceManager);
        registerCompactionSummaryRenderer(continuity, instanceManager);
      },
    },
    {
      name: 'Channel manager',
      fn: async () => {
        const { DiscordAdapter } = await import('../channels/adapters/discord-adapter');
        const { WhatsAppAdapter } = await import('../channels/adapters/whatsapp-adapter');
        const manager = getChannelManager();
        manager.registerAdapter(new DiscordAdapter());
        manager.registerAdapter(new WhatsAppAdapter());

        try {
          const db = getRLMDatabase().getRawDb();
          const credentialStore = new ChannelCredentialStore(db);
          const policyStore = new ChannelAccessPolicyStore(db);
          const savedCredentials = credentialStore.getAll();
          for (const credential of savedCredentials) {
            const platform = credential.platform as 'discord' | 'whatsapp';
            const adapter = manager.getAdapter(platform);
            if (!adapter) {
              continue;
            }

            const restoredSenders = restoreSavedAccessPolicy(adapter, platform, policyStore);
            const restoredMode = adapter.getAccessPolicy().mode;

            logger.info('Auto-reconnecting channel', {
              platform,
              restoredSenders: restoredSenders.length,
              mode: restoredMode,
            });

            adapter.connect({
              platform,
              token: credential.token,
              allowedSenders: restoredSenders,
              allowedChats: [],
            }).catch((err) => {
              logger.warn('Auto-reconnect failed', { platform, error: String(err) });
            });
          }
        } catch (err) {
          logger.warn('Failed to load saved channel credentials', { error: String(err) });
        }
      },
    },
    {
      name: 'Channel message router',
      fn: () => {
        const db = getRLMDatabase().getRawDb();
        const persistence = new ChannelPersistence(db);
        const router = new ChannelMessageRouter(getChannelManager(), persistence);
        router.setInstanceManager(instanceManager);
        router.start();
      },
    },
    {
      name: 'Domain bootstrap',
      fn: async () => {
        registerOrchestrationBootstrap();
        registerLearningBootstrap();
        registerMemoryBootstrap();
        registerInfrastructureBootstrap();
        const result = await bootstrapAll();
        if (result.failed.length > 0) {
          logger.warn('Some bootstrap modules failed (degraded mode)', {
            failed: result.failed,
          });
        }
      },
    },
    {
      name: 'Knowledge bridge',
      fn: () => {
        const bridge = getKnowledgeBridge();
        const reflector = getReflectorAgent();
        reflector.on('reflector:reflection-created', (reflection) => {
          bridge.onReflectionCreated(reflection);
        });
        reflector.on('reflector:promoted-to-procedural', (reflection) => {
          bridge.onPromotedToProcedural(reflection);
        });
        logger.info('Knowledge bridge wired to reflector events');
      },
    },
    { name: 'Codemem', fn: () => initializeCodemem() },
    {
      name: 'Browser Gateway',
      fn: () =>
        initializeBrowserGatewayRuntime({
          isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
        }),
    },
    {
      name: 'Cross-project patterns',
      fn: () => {
        getAgentTreePersistence().initialize().catch((err) => {
          logger.warn('Agent tree persistence initialization failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });

        try {
          const decisionStore = new PermissionDecisionStore(getRLMDatabase().getRawDb());
          getPermissionManager().setDecisionStore(decisionStore);
        } catch (err) {
          logger.warn('Failed to initialize permission decision store', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        try {
          const workflowPersistence = new WorkflowPersistence(getRLMDatabase().getRawDb());
          getWorkflowManager().setPersistence(workflowPersistence);
        } catch (err) {
          logger.warn('Failed to initialize workflow persistence', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const permissionRegistry = getPermissionRegistry();
        instanceManager.on('instance:removed', (instanceId: string) => {
          permissionRegistry.clearForInstance(instanceId);
          getOrchestrationSnapshotManager().clearForInstance(instanceId);
        });

        logger.info('Cross-project patterns initialized');
      },
    },
  ];
}
