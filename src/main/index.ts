/**
 * Main Process Entry Point
 * Initializes the Electron application and all core services
 */

// Must be first — registers @contracts/@sdk/@shared path aliases for Node.js runtime
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./register-aliases');

import { app, BrowserWindow, powerMonitor } from 'electron';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { IpcMainHandler } from './ipc/ipc-main-handler';
import { InstanceManager } from './instance/instance-manager';
import { getSettingsManager } from './core/config/settings-manager';
import { getHookManager } from './hooks/hook-manager';
import { registerDefaultMultiVerifyInvoker, registerDefaultReviewInvoker, registerDefaultDebateInvoker, registerDefaultWorkflowInvoker } from './orchestration/default-invokers';
import { getOrchestratorPluginManager } from './plugins/plugin-manager';
import { getObservationIngestor, getObserverAgent, getReflectorAgent } from './observation';
import { initializePathValidator } from './security/path-validator';
import { getCompactionCoordinator } from './context/compaction-coordinator';
import { ContextCompactor } from './context/context-compactor';
import { getOrchestrationActivityBridge } from './orchestration/orchestration-activity-bridge';
import { getDebateCoordinator } from './orchestration/debate-coordinator';
import { getMultiVerifyCoordinator } from './orchestration/multi-verify-coordinator';
import { getLogger } from './logging/logger';
import { getDoomLoopDetector } from './orchestration/doom-loop-detector';
import { initTruncationCleanup } from './util/tool-output-truncation';
import { evaluateContextWindowGuard } from './context/context-window-guard';
import { getRemoteObserverServer } from './remote/observer-server';
import { getRepoJobService } from './repo-jobs';
import {
  getSessionContinuityManager,
  getSessionContinuityManagerIfInitialized,
} from './session/session-continuity';
import { getResourceGovernor } from './process/resource-governor';
import { getHibernationManager } from './process/hibernation-manager';
import { getPoolManager } from './process/pool-manager';
import { getLoadBalancer } from './process/load-balancer';
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  getWorkerNodeHealth,
  handleNodeFailover,
  handleLateNodeReconnect,
  RpcEventRouter,
  getRemoteNodeConfig,
  hydrateRemoteNodeConfig,
} from './remote-node';
import type { UserActionRequest } from './orchestration/orchestration-handler';
import { getCrossModelReviewService } from './orchestration/cross-model-review-service';
import { registerCrossModelReviewIpcHandlers } from './ipc/cross-model-review-ipc';
import { getChannelManager, ChannelMessageRouter, ChannelPersistence, ChannelCredentialStore, ChannelAccessPolicyStore } from './channels';
import { getRLMDatabase } from './persistence/rlm-database';
// Bootstrap module registry (WS6) — replaces manual singleton wiring
import { bootstrapAll } from './bootstrap';
import { registerOrchestrationBootstrap } from './bootstrap/orchestration-bootstrap';
import { registerLearningBootstrap } from './bootstrap/learning-bootstrap';
import { registerMemoryBootstrap } from './bootstrap/memory-bootstrap';
import { registerInfrastructureBootstrap } from './bootstrap/infrastructure-bootstrap';
// Knowledge bridge still needed for reflector wiring (app-specific)
import { getKnowledgeBridge } from './memory/knowledge-bridge';
import { BaseCliAdapter } from './cli/adapters/base-cli-adapter';
// Child auto-announce
import { getChildAnnouncer } from './orchestration/child-announcer';
import type { ChildAnnouncement } from '../shared/types/child-announce.types';
// Cross-project pattern adoptions
import { getAgentTreePersistence } from './session/agent-tree-persistence';
import { getPermissionRegistry } from './orchestration/permission-registry';
import { getOrchestrationSnapshotManager } from './orchestration/orchestration-snapshot';
import { runCleanupFunctions } from './util/cleanup-registry';
import { getAppStore, addInstance, removeInstance, updateInstance, setGlobalState } from './state';
import type { InstanceSlice } from './state';
import type { Instance } from '../shared/types/instance.types';
import { getMemoryMonitor } from './memory';
import { getReactionEngine } from './reactions';
import { getWorkflowManager } from './workflows/workflow-manager';
import { getPermissionManager } from './security/permission-manager';
import { PermissionDecisionStore } from './security/permission-decision-store';
import { WorkflowPersistence } from './workflows/workflow-persistence';
import { initializeCodemem } from './codemem';
import { providerAdapterRegistry } from './providers/provider-adapter-registry';
import { registerBuiltInProviders } from './providers/register-built-in-providers';
import { toOutputMessageFromProviderEnvelope } from './providers/provider-output-event';
import { ProviderRuntimeEventEnvelopeSchema } from '@contracts/schemas/provider-runtime-events';
import { IPC_CHANNELS } from '@contracts/channels';

// Register built-in provider adapters once at startup so the instance
// manager (and future consumers) can look them up by ProviderName.
registerBuiltInProviders(providerAdapterRegistry);

const logger = getLogger('App');
const MAIN_PROCESS_MONITOR_INTERVAL_MS = 1000;
const MAIN_PROCESS_STALL_THRESHOLD_MS = 2000;
const POST_RESUME_GRACE_PERIOD_MS = 60_000;

let runtimeDiagnosticsInstalled = false;

function roundMegabytes(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function installRuntimeDiagnostics(): void {
  if (runtimeDiagnosticsInstalled) {
    return;
  }

  runtimeDiagnosticsInstalled = true;

  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') {
      return;
    }

    const detailRecord = details as unknown as Record<string, unknown>;
    logger.error('Electron child process exited unexpectedly', undefined, {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      name: detailRecord['name'],
      serviceName: detailRecord['serviceName'],
    });
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning emitted', {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });

  let lastTick = Date.now();
  const noteSystemSuspend = (source: 'suspend' | 'lock-screen'): void => {
    logger.info('System power event observed', { source });
    getObservationIngestor().handleSystemSuspend();
    getSessionContinuityManagerIfInitialized()?.handleSystemSuspend();
    getHibernationManager().handleSystemSuspend();
    getPoolManager().handleSystemSuspend();
  };
  const noteSystemResume = (source: 'resume' | 'unlock-screen'): void => {
    lastTick = Date.now();
    logger.info('System resumed; deferring background timers', {
      source,
      graceMs: POST_RESUME_GRACE_PERIOD_MS,
    });
    getObservationIngestor().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getSessionContinuityManagerIfInitialized()?.handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getHibernationManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
    getPoolManager().handleSystemResume(POST_RESUME_GRACE_PERIOD_MS);
  };

  powerMonitor.on('suspend', () => {
    noteSystemSuspend('suspend');
  });
  powerMonitor.on('resume', () => {
    noteSystemResume('resume');
  });
  powerMonitor.on('lock-screen', () => {
    noteSystemSuspend('lock-screen');
  });
  powerMonitor.on('unlock-screen', () => {
    noteSystemResume('unlock-screen');
  });

  const timer = setInterval(() => {
    const now = Date.now();
    const stallMs = now - lastTick - MAIN_PROCESS_MONITOR_INTERVAL_MS;
    lastTick = now;

    if (stallMs < MAIN_PROCESS_STALL_THRESHOLD_MS) {
      return;
    }

    const memory = process.memoryUsage();
    logger.warn('Main process event loop stall detected', {
      stallMs,
      windowCount: BrowserWindow.getAllWindows().length,
      rssMB: roundMegabytes(memory.rss),
      heapUsedMB: roundMegabytes(memory.heapUsed),
      heapTotalMB: roundMegabytes(memory.heapTotal),
      externalMB: roundMegabytes(memory.external),
      arrayBuffersMB: roundMegabytes(memory.arrayBuffers),
    });
  }, MAIN_PROCESS_MONITOR_INTERVAL_MS);
  timer.unref();
}

class AIOrchestratorApp {
  private windowManager: WindowManager;
  private ipcHandler: IpcMainHandler;
  private instanceManager: InstanceManager;
  private handlersRegistered = false;

  constructor() {
    this.windowManager = new WindowManager();
    this.instanceManager = new InstanceManager();
    this.ipcHandler = new IpcMainHandler(
      this.instanceManager,
      this.windowManager
    );
  }

  async initialize(): Promise<void> {
    logger.info('Initializing AI Orchestrator');

    // Only register once — handlers persist across window recreation
    if (!this.handlersRegistered) {
      const criticalSteps = new Set(['IPC handlers', 'Event forwarding']);

      const steps: { name: string; fn: () => Promise<void> | void }[] = [
        { name: 'IPC handlers', fn: () => this.ipcHandler.registerHandlers() },
        { name: 'Runtime diagnostics', fn: () => installRuntimeDiagnostics() },
        { name: 'Hook approvals', fn: () => getHookManager().loadApprovals() },
        {
          name: 'Remote observer',
          fn: () => getRemoteObserverServer().initialize({ instanceManager: this.instanceManager }),
        },
        { name: 'Event forwarding', fn: () => this.setupInstanceEventForwarding() },
        { name: 'Verification invokers', fn: () => registerDefaultMultiVerifyInvoker(this.instanceManager) },
        { name: 'Review invokers', fn: () => registerDefaultReviewInvoker(this.instanceManager) },
        { name: 'Debate invokers', fn: () => registerDefaultDebateInvoker(this.instanceManager) },
        { name: 'Workflow invokers', fn: () => registerDefaultWorkflowInvoker(this.instanceManager) },
        { name: 'Child auto-announce', fn: () => {
          const childAnnouncer = getChildAnnouncer();
          childAnnouncer.on('child:announced', (parentId: string, announcements: ChildAnnouncement[], message: string) => {
            const parent = this.instanceManager.getInstance(parentId);
            if (parent && parent.status !== 'terminated') {
              this.instanceManager.sendInput(parentId, message).catch((err) => {
                logger.warn('Failed to deliver child announcement to parent', {
                  parentId,
                  childIds: announcements.map(a => a.childId),
                  batchSize: announcements.length,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          });
        } },
        { name: 'Plugin manager', fn: () => getOrchestratorPluginManager().initialize(this.instanceManager) },
        { name: 'Reaction engine', fn: () => getReactionEngine().initialize(this.instanceManager) },
        { name: 'Observation ingestor', fn: () => getObservationIngestor().initialize(this.instanceManager) },
        { name: 'Observer agent', fn: () => { getObserverAgent(); } },
        { name: 'Reflector agent', fn: () => { getReflectorAgent(); } },
        { name: 'Path validator', fn: () => initializePathValidator() },
        { name: 'Compaction coordinator', fn: () => this.setupCompactionCoordinator() },
        // Doom loop detector init moved to orchestration-bootstrap (WS6)
        { name: 'Truncation cleanup', fn: () => { initTruncationCleanup(); } },
        { name: 'Resource governor', fn: () => {
          const im = this.instanceManager;
          getResourceGovernor().start({
            getInstanceManager: () => im,
          });
        } },
        { name: 'Hibernation manager', fn: () => {
          const hibernation = getHibernationManager();
          hibernation.start();
          hibernation.on('check-idle', () => {
            // Only consider child instances — root (user-created) instances
            // should never be auto-terminated from here.
            const instances = this.instanceManager.getAllInstances()
              .filter((i) => i.status === 'idle' && i.parentId)
              .map((i) => ({ id: i.id, status: i.status, lastActivity: i.lastActivity }));
            const candidates = hibernation.getHibernationCandidates(instances);
            for (const candidate of candidates) {
              this.instanceManager.terminateInstance(candidate.id, true).catch(err => logger.warn('Failed to terminate idle child instance', { error: err instanceof Error ? err.message : String(err) }));
            }
          });
        } },
        { name: 'Instance pool', fn: () => {
          const pool = getPoolManager();
          pool.start();
          pool.on('instance:evicted', ({ instanceId }: { instanceId: string }) => {
            this.instanceManager.terminateInstance(instanceId, true).catch(err => logger.warn('Failed to terminate instance', { error: err instanceof Error ? err.message : String(err) }));
          });
        } },
        { name: 'Load balancer', fn: () => { getLoadBalancer(); } },
        { name: 'Worker node subsystem', fn: async () => {
          hydrateRemoteNodeConfig(getSettingsManager().getAll());
          const config = getRemoteNodeConfig();
          if (!config.enabled) {
            logger.info('Remote node subsystem disabled');
            return;
          }

          const registry = getWorkerNodeRegistry();
          const connection = getWorkerNodeConnectionServer();

          // Start RPC event router
          const rpcRouter = new RpcEventRouter(connection, registry);
          rpcRouter.start();

          // Wire node disconnect → failover
          registry.on('node:disconnected', (node) => {
            const nodeId = typeof node === 'string' ? node : node.id;
            handleNodeFailover(nodeId, this.instanceManager);
            this.syncRemoteNodeMetricsToLoadBalancer(nodeId);
          });

          // Wire node events → renderer
          registry.on('node:connected', (node) => {
            this.windowManager.sendToRenderer('remote-node:event', { type: 'connected', node });
            // Check for instances left in 'failed' state from a prior disconnection.
            // On late reconnection (after reboot), restore them to 'idle' so the user
            // can resume working.
            const nodeId = typeof node === 'string' ? node : node.id;
            handleLateNodeReconnect(nodeId, this.instanceManager);
          });
          registry.on('node:disconnected', (node) => {
            this.windowManager.sendToRenderer('remote-node:event', {
              type: 'disconnected',
              nodeId: typeof node === 'string' ? node : node.id,
            });
          });
          registry.on('node:updated', (node) => {
            this.syncRemoteNodeMetricsToLoadBalancer(node.id);
            this.windowManager.sendToRenderer('remote-node:event', { type: 'updated', node });
          });

          // Start WebSocket server
          await connection.start(config.serverPort, config.serverHost);
          logger.info('Worker node subsystem started', {
            port: config.serverPort,
            host: config.serverHost,
          });
        } },
        { name: 'Cross-model review', fn: async () => {
          const crossModelReview = getCrossModelReviewService();
          crossModelReview.setInstanceManager(this.instanceManager);
          await crossModelReview.initialize();
          registerCrossModelReviewIpcHandlers();
        } },
        { name: 'Session continuity wiring', fn: () => {
          getSessionContinuityManager().setInstanceManager(this.instanceManager);
        } },
        { name: 'Channel manager', fn: async () => {
          const { DiscordAdapter } = await import('./channels/adapters/discord-adapter');
          const { WhatsAppAdapter } = await import('./channels/adapters/whatsapp-adapter');
          const manager = getChannelManager();
          manager.registerAdapter(new DiscordAdapter());
          manager.registerAdapter(new WhatsAppAdapter());

          // Auto-reconnect from saved credentials + restore access policies
          try {
            const db = getRLMDatabase().getRawDb();
            const credStore = new ChannelCredentialStore(db);
            const policyStore = new ChannelAccessPolicyStore(db);
            const saved = credStore.getAll();
            for (const cred of saved) {
              const platform = cred.platform as 'discord' | 'whatsapp';
              const adapter = manager.getAdapter(platform);
              if (adapter) {
                // Restore persisted access policy (paired senders, mode)
                const savedPolicy = policyStore.get(platform);
                const restoredSenders = savedPolicy
                  ? JSON.parse(savedPolicy.allowed_senders_json) as string[]
                  : [];
                const restoredMode = savedPolicy?.mode ?? 'pairing';

                logger.info('Auto-reconnecting channel', {
                  platform,
                  restoredSenders: restoredSenders.length,
                  mode: restoredMode,
                });

                // Pre-apply the access policy before connecting so it's active
                // even if connect() is slow
                adapter.setAccessPolicy({
                  ...adapter.getAccessPolicy(),
                  mode: restoredMode as 'pairing' | 'allowlist' | 'disabled',
                  allowedSenders: restoredSenders,
                });

                adapter.connect({
                  platform,
                  token: cred.token,
                  allowedSenders: restoredSenders,
                  allowedChats: [],
                }).catch(err => {
                  logger.warn('Auto-reconnect failed', { platform, error: String(err) });
                });
              }
            }
          } catch (err) {
            logger.warn('Failed to load saved channel credentials', { error: String(err) });
          }
        } },
        { name: 'Channel message router', fn: () => {
          const db = getRLMDatabase().getRawDb();
          const persistence = new ChannelPersistence(db);
          const router = new ChannelMessageRouter(getChannelManager(), persistence);
          router.setInstanceManager(this.instanceManager);
          router.start();
        } },

        // --- Domain singletons (WS6: bootstrap registry) ---
        { name: 'Domain bootstrap', fn: async () => {
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
        } },

        // Knowledge bridge wiring (app-specific: needs reflector agent)
        { name: 'Knowledge bridge', fn: () => {
          const bridge = getKnowledgeBridge();
          const reflector = getReflectorAgent();
          reflector.on('reflector:reflection-created', (reflection) => {
            bridge.onReflectionCreated(reflection);
          });
          reflector.on('reflector:promoted-to-procedural', (reflection) => {
            bridge.onPromotedToProcedural(reflection);
          });
          logger.info('Knowledge bridge wired to reflector events');
        } },

        { name: 'Codemem', fn: () => initializeCodemem() },

        // === Cross-project pattern adoptions ===
        { name: 'Cross-project patterns', fn: () => {
          // Initialize agent tree persistence
          getAgentTreePersistence().initialize().catch((err) => {
            logger.warn('Agent tree persistence initialization failed', { error: err instanceof Error ? err.message : String(err) });
          });

          // Wire permission decision persistence
          try {
            const decisionStore = new PermissionDecisionStore(getRLMDatabase().getRawDb());
            getPermissionManager().setDecisionStore(decisionStore);
          } catch (err) {
            logger.warn('Failed to initialize permission decision store', { error: err instanceof Error ? err.message : String(err) });
          }

          // Wire workflow execution persistence
          try {
            const workflowPersistence = new WorkflowPersistence(getRLMDatabase().getRawDb());
            getWorkflowManager().setPersistence(workflowPersistence);
          } catch (err) {
            logger.warn('Failed to initialize workflow persistence', { error: err instanceof Error ? err.message : String(err) });
          }

          // Initialize permission registry cleanup on instance removal
          const permissionRegistry = getPermissionRegistry();
          this.instanceManager.on('instance:removed', (instanceId: string) => {
            permissionRegistry.clearForInstance(instanceId);
            getOrchestrationSnapshotManager().clearForInstance(instanceId);
          });

          logger.info('Cross-project patterns initialized');
        } },
      ];

      for (const step of steps) {
        try {
          logger.info(`Initializing: ${step.name}`);
          await step.fn();
          logger.info(`Initialized: ${step.name}`);
        } catch (error) {
          logger.error(`Failed to initialize: ${step.name}`, error instanceof Error ? error : undefined);
          if (criticalSteps.has(step.name)) {
            throw error;
          }
        }
      }

      this.handlersRegistered = true;
    }

    // Create main window (this loads the renderer which may call IPC)
    await this.windowManager.createMainWindow();

    logger.info('AI Orchestrator initialized');
  }

  /**
   * Codex/Gemini adapters are currently exec-per-message (stateless).
   * Context threshold auto-guards are designed for stateful sessions.
   */
  private isStatelessExecProvider(provider: string | undefined): boolean {
    return provider === 'codex' || provider === 'gemini';
  }

  private getNodeLatencyForInstance(instanceId: string): number | undefined {
    const instance = this.instanceManager.getInstance(instanceId);
    if (!instance || instance.executionLocation.type !== 'remote') {
      return undefined;
    }

    return getWorkerNodeRegistry().getNode(instance.executionLocation.nodeId)?.latencyMs;
  }

  private syncRemoteNodeMetricsToLoadBalancer(nodeId: string): void {
    const loadBalancer = getLoadBalancer();
    const nodeLatencyMs = getWorkerNodeRegistry().getNode(nodeId)?.latencyMs;

    for (const instance of this.instanceManager.getInstancesByNode(nodeId)) {
      loadBalancer.updateMetrics(instance.id, {
        activeTasks: 0,
        contextUsagePercent: instance.contextUsage?.percentage ?? 0,
        memoryPressure: 'normal',
        status: instance.status,
        nodeLatencyMs,
      });
    }
  }

  private setupInstanceEventForwarding(): void {
    const observer = getRemoteObserverServer();
    const repoJobs = getRepoJobService();

    // Forward instance events to renderer
    this.instanceManager.on('instance:created', (instance) => {
      this.windowManager.sendToRenderer('instance:created', instance);
      observer.publishInstanceState({
        type: 'created',
        instanceId: instance.id,
        displayName: instance.displayName,
        status: instance.status,
      });
      // Track for session continuity (auto-save)
      try {
        getSessionContinuityManager().startTracking(instance);
      } catch (error) {
        logger.warn('Failed to start session tracking', { instanceId: instance.id, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.instanceManager.on('instance:removed', (instanceId) => {
      this.windowManager.sendToRenderer('instance:removed', instanceId);
      getCompactionCoordinator().cleanupInstance(instanceId as string);
      getDoomLoopDetector().cleanupInstance(instanceId as string);
      getLoadBalancer().removeMetrics(instanceId as string);
      getWorkflowManager().cleanupInstance(instanceId as string);
      observer.publishInstanceState({
        type: 'removed',
        instanceId,
      });
      // Stop tracking and archive for potential resume
      try {
        getSessionContinuityManager().stopTracking(instanceId as string, true);
      } catch (error) {
        logger.warn('Failed to stop session tracking', { instanceId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    this.instanceManager.on('instance:state-update', (update) => {
      this.windowManager.sendToRenderer('instance:state-update', update);
      observer.publishInstanceState(update as Record<string, unknown>);
    });

    this.instanceManager.on('provider:normalized-event', (envelope) => {
      if (process.env['NODE_ENV'] !== 'production') {
        ProviderRuntimeEventEnvelopeSchema.parse(envelope);
      }

      this.windowManager.sendToRenderer(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT, envelope);
      const message = toOutputMessageFromProviderEnvelope(envelope);
      if (!message) {
        return;
      }

      observer.publishInstanceOutput(envelope.instanceId, message);
      try {
        const continuity = getSessionContinuityManager();
        const instance = this.instanceManager.getInstance(envelope.instanceId);
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

    this.instanceManager.on('instance:batch-update', (updates) => {
      this.windowManager.sendToRenderer('instance:batch-update', updates);
      observer.publishInstanceState({
        type: 'batch-update',
        ...(updates as Record<string, unknown>),
      });

      // Feed context usage updates to compaction coordinator and context window guard
      const data = updates as { updates?: { instanceId: string; status?: string; contextUsage?: { used: number; total: number; percentage: number } }[] };
      if (data.updates) {
        const coordinator = getCompactionCoordinator();
        for (const update of data.updates) {
          if (update.contextUsage) {
            const instance = this.instanceManager.getInstance(update.instanceId);
            if (this.isStatelessExecProvider(instance?.provider)) {
              continue;
            }

            coordinator.onContextUpdate(update.instanceId, update.contextUsage);

            // Evaluate context window guard for low-context warnings
            const remaining = update.contextUsage.total - update.contextUsage.used;
            const guardResult = evaluateContextWindowGuard(remaining);
            if (guardResult.shouldWarn || !guardResult.allowed) {
              this.windowManager.sendToRenderer('context:warning', {
                instanceId: update.instanceId,
                ...guardResult,
              });
            }
          }
        }
      }
      // Update session continuity with latest context usage
      if (data.updates) {
        const continuity = getSessionContinuityManager();
        const lb = getLoadBalancer();
        for (const update of data.updates) {
          if (update.contextUsage) {
            continuity.updateState(update.instanceId, {
              contextUsage: {
                used: update.contextUsage.used,
                total: update.contextUsage.total,
              },
            });
          }
          // Update load balancer metrics
          if (update.instanceId) {
            lb.updateMetrics(update.instanceId, {
              activeTasks: 0,
              contextUsagePercent: update.contextUsage
                ? Math.round((update.contextUsage.used / update.contextUsage.total) * 100)
                : 0,
              memoryPressure: 'normal',
              status: update.status || 'idle',
              nodeLatencyMs: this.getNodeLatencyForInstance(update.instanceId),
            });
          }
        }
      }
    });

    // Wire instance events to cross-model review
    const crossModelReview = getCrossModelReviewService();

    this.instanceManager.on('provider:normalized-event', (envelope) => {
      const message = toOutputMessageFromProviderEnvelope(envelope);
      if (!message || message.metadata?.['source'] === 'cross-model-review') return;
      const instance = this.instanceManager.getInstance(envelope.instanceId);
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

    this.instanceManager.on('instance:batch-update', ({ updates }) => {
      for (const update of updates) {
        if (update.status === 'idle' || update.status === 'waiting_for_input') {
          crossModelReview.onInstanceIdle(update.instanceId).catch(err =>
            logger.warn('Review trigger failed', { instanceId: update.instanceId, error: String(err) })
          );
        }
      }
    });

    // instance:removed emits a plain string, NOT an object
    this.instanceManager.on('instance:removed', (instanceId: string) => {
      crossModelReview.cancelPendingReviews(instanceId);
    });

    // Forward cross-model review events to renderer
    crossModelReview.on('review:started', (data) => {
      this.windowManager.sendToRenderer('cross-model-review:started', data);
    });
    crossModelReview.on('review:result', (data) => {
      this.windowManager.sendToRenderer('cross-model-review:result', data);
    });
    crossModelReview.on('review:all-unavailable', (data) => {
      this.windowManager.sendToRenderer('cross-model-review:all-unavailable', data);
    });

    // Forward input-required events (permission prompts) to renderer
    this.instanceManager.on('instance:input-required', (payload) => {
      this.windowManager.sendToRenderer('instance:input-required', payload);
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

    // Forward doom loop detection events to renderer
    getDoomLoopDetector().on('doom-loop-detected', (event) => {
      logger.warn('Forwarding doom loop event to renderer', { instanceId: event.instanceId, toolName: event.toolName });
      this.windowManager.sendToRenderer('instance:doom-loop', event);
    });

    // Forward user action requests from orchestrator to renderer
    const orchestration = this.instanceManager.getOrchestrationHandler();
    orchestration.on('user-action-request', (request: UserActionRequest) => {
      logger.info('Forwarding user action request to renderer', { requestId: request.id });
      this.windowManager.sendToRenderer('user-action:request', request);
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

      // Notify the user for all request types so questions don't get lost
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
      this.windowManager.notifyUserActionRequest(
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

    // Forward orchestration activity (child spawn, debate, verification) to renderer
    const activityBridge = getOrchestrationActivityBridge();
    activityBridge.initialize(
      this.windowManager,
      orchestration,
      getDebateCoordinator(),
      getMultiVerifyCoordinator()
    );

    // ── Shadow events into immutable store (additive — existing wiring above unchanged) ──

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

    this.instanceManager.on('instance:created', (instance: Instance) => {
      try { addInstance(toSlice(instance)); } catch { /* store failure must not block main flow */ }
    });

    this.instanceManager.on('instance:removed', (instanceId: string) => {
      try { removeInstance(instanceId); } catch { /* non-critical */ }
    });

    this.instanceManager.on('instance:state-update', (update: Record<string, unknown>) => {
      const id = update['instanceId'] as string | undefined;
      if (!id) return;
      const instance = this.instanceManager.getInstance(id);
      if (!instance) return;
      try { updateInstance(id, toSlice(instance)); } catch { /* non-critical */ }
    });

    this.instanceManager.on('instance:batch-update', (payload: {
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

    // Mirror memory pressure into the global app store
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

    // Eagerly initialize the app store so it's ready before any event fires
    getAppStore();
  }

  private setupCompactionCoordinator(): void {
    const coordinator = getCompactionCoordinator();

    // Configure native compaction strategy: send /compact for providers that support it
    coordinator.configure({
      nativeCompact: async (instanceId: string) => {
        try {
          await this.instanceManager.sendInput(instanceId, '/compact');
          // The CLI will process /compact internally and context usage
          // will be updated via the normal batch-update flow
          return true;
        } catch {
          return false;
        }
      },
      supportsNativeCompaction: (instanceId: string) => {
        const capabilities = this.instanceManager.getAdapterRuntimeCapabilities(instanceId);
        return capabilities?.supportsNativeCompaction ?? false;
      },
      restartCompact: async (instanceId: string) => {
        // Use the singleton ContextCompactor with clear-before-use to avoid
        // cross-instance contamination. The CompactionCoordinator's
        // compactingInstances guard serialises concurrent compaction attempts.
        const compactor = ContextCompactor.getInstance();
        try {
          const instance = this.instanceManager.getInstance(instanceId);
          if (!instance) return false;

          // Clear any stale state before building turns for this instance
          compactor.clear();

          // Build conversation turns from the output buffer
          const turns = instance.outputBuffer
            .filter(msg => msg.type === 'user' || msg.type === 'assistant')
            .map(msg => ({
              role: msg.type as 'user' | 'assistant',
              content: msg.content,
              tokenCount: Math.ceil(msg.content.length / 4),
            }));

          for (const turn of turns) {
            compactor.addTurn(turn);
          }

          const compactionResult = await compactor.compact();

          // Get the summary text
          const summaries = compactor.getState().summaries;
          const latestSummary = summaries[summaries.length - 1];
          const summaryText = latestSummary?.content || 'Previous conversation context was compacted.';

          const latestUserMessage = [...instance.outputBuffer]
            .reverse()
            .find(msg => msg.type === 'user');
          const currentObjective = latestUserMessage?.content || 'Continue from the previous task.';

          const unresolvedItems = instance.outputBuffer
            .slice(-30)
            .flatMap(msg => {
              const matches = msg.content.match(/(?:^|\n)\s*(?:- \[ \]|todo[:-]|next[:-]|follow-up[:-])\s*(.+)/gi) || [];
              return matches.map(m =>
                m.replace(/(?:^|\n)\s*(?:- \[ \]|todo[:-]|next[:-]|follow-up[:-])\s*/i, '').trim()
              );
            })
            .filter(Boolean)
            .slice(0, 5);

          const recentTurns = instance.outputBuffer
            .filter(msg => msg.type === 'user' || msg.type === 'assistant')
            .slice(-8)
            .map(msg => {
              const role = msg.type === 'user' ? 'User' : 'Assistant';
              const content = msg.content.length > 400
                ? `${msg.content.slice(0, 400)}...[truncated]`
                : msg.content;
              return `- ${role}: ${content}`;
            });

          const continuityPrompt = [
            '[Context Compaction Continuity Package]',
            'Compaction method: restart-with-summary',
            '',
            'Objective:',
            currentObjective,
            '',
            'Unresolved items:',
            unresolvedItems.length > 0 ? unresolvedItems.map(item => `- ${item}`).join('\n') : '- None captured.',
            '',
            'Compacted summary:',
            summaryText,
            '',
            'Recent turns:',
            recentTurns.length > 0 ? recentTurns.join('\n') : '- No recent turns available.',
            '',
            'Continue from this state without redoing completed work.',
            '[End Continuity Package]',
          ].join('\n');

          // Restart instance with summary as initial prompt
          await this.instanceManager.restartInstance(instanceId);

          // Send structured continuity package as the first message to re-seed context
          await this.instanceManager.sendInput(instanceId, continuityPrompt);

          logger.info('restart-with-summary compaction completed', { instanceId, reductionRatio: compactionResult.reductionRatio });

          return true;
        } catch (error) {
          logger.error('Restart-with-summary compaction failed', error instanceof Error ? error : undefined);
          return false;
        } finally {
          compactor.clear();
        }
      },
    });

    // Forward compaction coordinator events to renderer
    coordinator.on('context-warning', (payload) => {
      this.windowManager.sendToRenderer('context:warning', payload);
    });

    coordinator.on('compaction-started', (payload) => {
      this.windowManager.sendToRenderer('instance:compact-status', {
        ...payload,
        status: 'started',
      });
    });

    coordinator.on('compaction-completed', (payload) => {
      const { instanceId, result } = payload;
      this.windowManager.sendToRenderer('instance:compact-status', {
        instanceId,
        ...result,
        status: 'completed',
      });

      // Insert boundary message into instance output buffer
      if (result.success) {
        const instance = this.instanceManager.getInstance(instanceId);
        if (instance) {
          const boundaryMessage = {
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            type: 'system' as const,
            content: '— Context compacted —',
            metadata: {
              isCompactionBoundary: true,
              method: result.method,
              previousUsage: result.previousUsage,
              newUsage: result.newUsage,
            },
          };
          this.instanceManager.emitOutputMessage(instanceId, boundaryMessage);
        }
      }
    });

    coordinator.on('compaction-error', (payload) => {
      this.windowManager.sendToRenderer('instance:compact-status', {
        ...payload,
        status: 'error',
      });
    });
  }

  /**
   * Synchronous best-effort shutdown — guarantees state is saved and processes
   * are signaled even if the async cleanup phase hangs or times out.
   *
   * Inspired by Claude Code's writeSync()-first pattern in gracefulShutdown.ts.
   */
  cleanupSync(): void {
    // Save all dirty session states synchronously (writeFileSync)
    try {
      getSessionContinuityManagerIfInitialized()?.shutdown();
    } catch (error) {
      logger.error('Sync session save failed', error instanceof Error ? error : undefined);
    }

    // Send SIGTERM to all tracked CLI processes
    try {
      BaseCliAdapter.killAllActiveProcesses();
    } catch (error) {
      logger.error('Sync process kill failed', error instanceof Error ? error : undefined);
    }
  }

  async cleanup(): Promise<void> {
    try { setGlobalState({ shutdownRequested: true }); } catch { /* non-critical */ }
    logger.info('Cleaning up');
    await runCleanupFunctions();
    try { getWorkerNodeHealth().stopAll(); } catch { /* best effort */ }
    try { getWorkerNodeConnectionServer().stop(); } catch { /* best effort */ }
    try { getResourceGovernor().stop(); } catch { /* best effort */ }
    try { getHibernationManager().stop(); } catch { /* best effort */ }
    try { getPoolManager().stop(); } catch { /* best effort */ }
    try { getCrossModelReviewService().shutdown(); } catch { /* best effort */ }
    try { getChannelManager().shutdown(); } catch { /* best effort */ }
    // Session state already saved synchronously in cleanupSync()
    try { await getChannelManager().shutdown(); } catch { /* best effort */ }

    // CRITICAL: await terminateAll so every instance is archived to history
    // before the process exits. Without this, conversations are lost on quit.
    await this.instanceManager.terminateAll();
    // Kill any orphaned child processes that were not cleaned up by terminateAll.
    BaseCliAdapter.killAllActiveProcesses();
    logger.info('Cleanup complete — all instances archived');
  }
}

// Prevent macOS Keychain popup for Chromium's encrypted storage.
// Without this, Electron triggers "AI Orchestrator wants to use your
// confidential information stored in 'ai-orchestrator Safe Storage'" on launch.
// `use-mock-keychain` is the macOS-specific switch; `password-store=basic` is Linux-only.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain');
} else if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'basic');
}

// Application instance
let orchestratorApp: AIOrchestratorApp | null = null;

// App ready handler
app.whenReady().then(async () => {
  // Set dock icon on macOS (only in development mode - packaged app uses icon from Info.plist)
  if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
    try {
      const iconPath = path.join(__dirname, '../../build/icon.png');
      app.dock.setIcon(iconPath);
    } catch {
      // Icon not found, ignore - packaged app uses Info.plist icon
    }
  }

  orchestratorApp = new AIOrchestratorApp();
  await orchestratorApp.initialize();

  // macOS: Re-create window when dock icon is clicked
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await orchestratorApp?.initialize();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Clean up before quit — must await async cleanup before the process exits,
// otherwise in-flight history archiving is silently dropped.
let cleanupDone = false;
const CLEANUP_TIMEOUT_MS = 10_000;

app.on('before-quit', (event) => {
  if (cleanupDone || !orchestratorApp) return;

  // Phase 1: Synchronous — guaranteed state save + process signaling
  orchestratorApp.cleanupSync();

  // Phase 2: Async — thorough cleanup with timeout
  event.preventDefault();
  cleanupDone = true;

  const timeout = setTimeout(() => {
    logger.warn('Cleanup timed out — forcing quit');
    app.exit(0);
  }, CLEANUP_TIMEOUT_MS);

  orchestratorApp.cleanup()
    .catch((error) => {
      logger.error('Cleanup failed', error instanceof Error ? error : undefined);
    })
    .finally(() => {
      clearTimeout(timeout);
      app.quit();
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error instanceof Error ? error : undefined);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : undefined, { reason: String(reason) });
});
