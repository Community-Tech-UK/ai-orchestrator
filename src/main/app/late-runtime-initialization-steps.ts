/**
 * Late-boot initialization steps (Loop store through Cross-project patterns).
 *
 * Extracted from `initialization-steps.ts` so the core boot list stays inside
 * its LOC ceiling. Step order and fail-soft behaviour are unchanged.
 */

import { app } from 'electron';
import { statSync } from 'node:fs';
import { registerDefaultLoopInvoker } from '../orchestration/default-invokers';
import { getLoopStoreService } from '../orchestration/loop-store';
import { reconcileManagedWorktreeLifecycles } from '../orchestration/loop-worktree-lifecycle-reconcile';
import { reconcileOrphanedWorktrees } from '../orchestration/loop-worktree-reconcile';
import { getOrchestratorPluginManager } from '../plugins/plugin-manager';
import { getObservationIngestor, getObserverAgent, getReflectorAgent } from '../observation';
import { initializePathValidator } from '../security/path-validator';
import { getLogger } from '../logging/logger';
import { initTruncationCleanup } from '../util/tool-output-truncation';
import { sweepStaleCodexTempHomes } from '../cli/adapters/codex/codex-home-manager';
import { reconcilePrivateCodexRolloutPaths } from '../cli/adapters/codex/codex-private-rollout-reconcile';
import { cleanupLeakedAioCodexThreads } from '../cli/adapters/codex/codex-state-cleanup';
import { getSessionContinuityManager } from '../session/session-continuity';
import { getSessionAdmissionService } from '../session/session-admission-service';
import { initializeArtifactCleanupMaintenance } from '../session/artifact-cleanup-maintenance';
import { registerBuiltinTerminationGates } from '../session/builtin-termination-gates';
import { initializeSessionRecoveryRuntime } from './session-recovery-initialization';
import { getResourceGovernor } from '../process/resource-governor';
import { getCliAutoUpdateService } from '../cli/cli-auto-update-service';
import { getHibernationManager } from '../process/hibernation-manager';
import { getPoolManager } from '../process/pool-manager';
import { getLoadBalancer } from '../process/load-balancer';
import { getCrossModelReviewService } from '../orchestration/cross-model-review-service';
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
import { getReactionEngine } from '../reactions';
import { getCampaignCoordinator } from '../orchestration/campaign-coordinator';
import { initializeCodemem, getCodemem } from '../codemem';
import { initializeBrowserGatewayRuntime } from '../browser-gateway';
import { initializeDesktopGatewayRuntime } from '../desktop-gateway';
import { initializeCodememRpcServer } from '../codemem/codemem-rpc-server';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { setupCompactionCoordinator } from './compaction-runtime';
import { LongRunResourceGovernor } from '../runtime/long-run-resource-governor';
import { RLM_STORAGE_HARD_LIMIT_BYTES } from '../../shared/types/rlm-maintenance.types';
import { getContextWorkerClient } from '../instance/context-worker-client';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import {
  createCodebaseAutoIndexCoordinatorStep,
  createCodememPrewarmCoordinatorStep,
  createProjectKnowledgeAutoMirrorCoordinatorStep,
} from './indexing-initialization-steps';
import { createOrchestratorToolsStep } from './orchestrator-tools-step';
import {
  createMobileGatewayStep,
  createThinClientWsStep,
  createWorkerNodeSubsystemStep,
} from './remote-gateway-initialization-steps';
import { getSettingsManager } from '../core/config/settings-manager';
import { createCrossProjectPatternsStep } from './cross-project-initialization-step';
import type { AppInitializationContext, AppInitializationStep } from './initialization-steps';

const logger = getLogger('AppInitialization');
const CODEMEM_MAINTENANCE_COOLDOWN_MS = 30 * 60 * 1000;

function safeFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function createLateRuntimeInitializationSteps(
  context: AppInitializationContext,
): AppInitializationStep[] {
  const { instanceManager, windowManager } = context;

  return [
    {
      name: 'Loop store',
      fn: async () => {
        try {
          const service = getLoopStoreService();
          // Mark any "running" loops as paused on boot so the user can review.
          const interrupted = service.store.markRunningAsInterruptedOnBoot();
          if (interrupted > 0) {
            logger.info(`Loop store: marked ${interrupted} previously-running loop(s) as paused on boot`);
          }

          // Resume AIO-managed lifecycle rows first: these may still need
          // harvest, integration, or base promotion before their directory can
          // be reaped. Legacy rows without lifecycle metadata fall through to
          // the compatibility orphan cleanup below.
          await reconcileManagedWorktreeLifecycles(service.store);

          // P3 compatibility reconcile: clean up orphaned worktrees left by
          // terminal loops whose async cleanup did not complete (crash, forced
          // quit). Runs before the intent reconciler so it does not race it.
          // Logic lives in `loop-worktree-reconcile.ts` so it is unit-testable.
          await reconcileOrphanedWorktrees(service.store);

          // NB2 reconciler: walk `<workspaceCwd>/.aio-loop-control/<loopRunId>/imported/`
          // for every resumable loop and import any intent files whose ids
          // aren't yet in `loop_terminal_intents`. Closes the residual
          // crash window where the DB transaction never committed but the
          // source file was already moved out of `intents/`. See
          // `docs/plans/2026-05-12-loop-terminal-control-spec.md` (NB2 / orphan reconciler).
          const { listArchivedImportedIntentsByLoop } = await import(
            '../orchestration/loop-control'
          );
          const resumable = service.store.listResumableRuns();
          let totalReconciled = 0;
          for (const { runRow, config } of resumable) {
            const workspaceCwd = typeof config.workspaceCwd === 'string' ? config.workspaceCwd : null;
            if (!workspaceCwd) continue;
            try {
              const orphans = await listArchivedImportedIntentsByLoop(workspaceCwd, runRow.id);
              if (orphans.length === 0) continue;
              const knownIds = service.store.getKnownTerminalIntentIds(runRow.id);
              for (const intent of orphans) {
                if (knownIds.has(intent.id)) continue;
                try {
                  service.store.upsertTerminalIntent(intent);
                  totalReconciled += 1;
                } catch (err) {
                  logger.warn('Loop store: failed to reconcile orphan terminal intent', {
                    loopRunId: runRow.id,
                    intentId: intent.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            } catch (err) {
              logger.warn('Loop store: orphan scan failed for loop', {
                loopRunId: runRow.id,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (totalReconciled > 0) {
            logger.info(`Loop store: reconciled ${totalReconciled} orphan terminal intent(s) from disk`);
          }
          const resumableCheckpoints = service.store.listResumableCheckpoints();
          if (resumableCheckpoints.length > 0) {
            logger.info(`Loop store: ${resumableCheckpoints.length} loop checkpoint(s) available for manual resume`);
          }
        } catch (error) {
          logger.warn('Loop store initialization failed; Loop Mode IPC will report degraded errors', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Campaign coordinator',
      fn: async () => {
        try {
          const coordinator = getCampaignCoordinator();
          coordinator.initialize();
          await coordinator.recoverInterruptedCampaigns();
        } catch (error) {
          logger.warn('Campaign coordinator initialization failed; campaign IPC will report degraded errors', {
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
    {
      name: 'Reaction engine',
      fn: () => {
        const settings = getSettingsManager();
        const engine = getReactionEngine();
        engine.initialize(instanceManager, {
          // Default-on: an unset setting resolves to the DEFAULT_SETTINGS value (true).
          enabled: settings.get('reactionsEnabled') !== false,
          pollIntervalMs: (settings.get('reactionsPollIntervalMs') as number | undefined) ?? 60_000,
        });
        // Live-apply settings changes (the generic settings UI writes through the
        // settings-manager, not the REACTION_UPDATE_CONFIG IPC, so subscribe here
        // to start/stop the engine without requiring a restart).
        settings.on('setting:reactionsEnabled', (value: unknown) => {
          engine.updateConfig({ enabled: value !== false });
        });
        settings.on('setting:reactionsPollIntervalMs', (value: unknown) => {
          if (typeof value === 'number') engine.updateConfig({ pollIntervalMs: value });
        });
      },
    },
    { name: 'Observation ingestor', fn: () => getObservationIngestor().initialize(instanceManager) },
    { name: 'Observer agent', fn: () => { getObserverAgent(); } },
    { name: 'Reflector agent', fn: () => { getReflectorAgent(); } },
    { name: 'Path validator', fn: () => initializePathValidator() },
    {
      name: 'Compaction coordinator',
      fn: () => setupCompactionCoordinator(instanceManager, windowManager),
    },
    { name: 'Truncation cleanup', fn: () => { initTruncationCleanup(); } },
    { name: 'Leaked AIO Codex thread cleanup', fn: () => { cleanupLeakedAioCodexThreads(); } },
    { name: 'Private Codex rollout-path reconcile', fn: () => { reconcilePrivateCodexRolloutPaths(); } },
    { name: 'Stale Codex temp home sweep', fn: () => { sweepStaleCodexTempHomes(); } },
    { name: 'Artifact cleanup maintenance', fn: () => { initializeArtifactCleanupMaintenance(); } },
    {
      name: 'Resource governor',
      fn: () => {
        getResourceGovernor().start({
          getInstanceManager: () => instanceManager,
          getDiagnosticsDir: () => path.join(app.getPath('userData'), 'diagnostics'),
        });
        const longRunGovernor = new LongRunResourceGovernor({
          warnRssBytes: 12 * 1024 * 1024 * 1024,
          criticalRssBytes: 18 * 1024 * 1024 * 1024,
          maxCodememDbBytes: 25 * 1024 * 1024 * 1024,
          maxRlmDbBytes: RLM_STORAGE_HARD_LIMIT_BYTES,
        });
        let codememMaintenanceRunning = false;
        let lastCodememMaintenanceStartedAt = 0;
        getLoopCoordinator().setResourceGovernor(() => {
          const userDataPath = app.getPath('userData');
          const codemem = getCodemem();
          const decision = longRunGovernor.evaluate({
            rssBytes: process.memoryUsage().rss,
            codememDbBytes: safeFileSize(path.join(userDataPath, 'codemem.sqlite')),
            rlmDbBytes: safeFileSize(path.join(userDataPath, 'rlm', 'rlm.db'))
              + safeFileSize(path.join(userDataPath, 'rlm', 'rlm.db-wal')),
            contextWorkerDegraded: getContextWorkerClient().getMetrics().degraded,
            indexWorkerDegraded: codemem.indexWorkerGateway.getMetrics().degraded,
          });
          if (decision.actions.includes('prune-codemem')) {
            const now = Date.now();
            if (!codememMaintenanceRunning && now - lastCodememMaintenanceStartedAt >= CODEMEM_MAINTENANCE_COOLDOWN_MS) {
              codememMaintenanceRunning = true;
              lastCodememMaintenanceStartedAt = now;
              codemem.indexWorkerGateway.runMaintenance()
                .then((result) => {
                  if (result) logger.info('Codemem maintenance completed', { ...result });
                })
                .catch((error) => logger.warn('Codemem maintenance failed', {
                  error: error instanceof Error ? error.message : String(error),
                }))
                .finally(() => { codememMaintenanceRunning = false; });
            }
          }
          return decision;
        });
      },
    },
    {
      // Phase 2 of the provider-model-auto-update plan: when the user opts into
      // `cliUpdatePolicy: 'auto'`, apply safe CLI updates unattended. The active-
      // instance count is injected (InstanceManager is intentionally not a
      // singleton) so updates never run while a session is live.
      name: 'CLI auto-update',
      fn: () => {
        getCliAutoUpdateService().start({
          getActiveInstanceCount: () => instanceManager.getInstanceCount(),
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
    createThinClientWsStep(),
    createWorkerNodeSubsystemStep(context),
    createMobileGatewayStep(instanceManager),
    {
      name: 'Cross-model review',
      fn: async () => {
        const crossModelReview = getCrossModelReviewService();
        crossModelReview.setInstanceManager(instanceManager);
        // Install the headless review execution host so `runHeadlessReview`
        // can dispatch prompts to alternative CLI providers from inside the
        // running app (not just from the standalone `review` CLI entrypoint).
        // Without this, runHeadlessReview returns the "host not configured"
        // stub and the loop's fresh-eyes review gate is a no-op.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { ProviderReviewExecutionHost } = require(
            '../review/review-execution-host',
          ) as typeof import('../review/review-execution-host');
          crossModelReview.setReviewExecutionHost(new ProviderReviewExecutionHost());
        } catch (err) {
          logger.warn('Failed to install ProviderReviewExecutionHost', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        await crossModelReview.initialize();
        // Ping-pong reviewer spawner shares the InstanceManager so it can spawn
        // fresh root-level reviewer instances for the agentic ping-pong gate.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getReviewerSessionSpawner } = require(
            '../orchestration/reviewer-session-spawner',
          ) as typeof import('../orchestration/reviewer-session-spawner');
          getReviewerSessionSpawner().setInstanceManager(instanceManager);
        } catch (err) {
          logger.warn('Failed to wire ReviewerSessionSpawner', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    {
      name: 'Session continuity wiring',
      fn: () => {
        const continuity = getSessionContinuityManager();
        continuity.setInstanceManager(instanceManager);
        // C5/§3.6: Initialize last-stop snapshot alongside session continuity.
        // Stored in the same continuity directory for co-location.
        initializeSessionRecoveryRuntime(continuity, instanceManager);
        // C6: give the (previously empty) termination-gate framework real,
        // advisory gates so dropped in-flight work is surfaced on teardown.
        registerBuiltinTerminationGates(continuity);
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
              displayName: credential.display_name ?? undefined,
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
    createCodememPrewarmCoordinatorStep(),
    createCodebaseAutoIndexCoordinatorStep(),
    createProjectKnowledgeAutoMirrorCoordinatorStep(),
    {
      name: 'Browser Gateway',
      fn: () =>
        initializeBrowserGatewayRuntime({
          isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
          resolveCheckpointOwner: (instanceId) => {
            const workingDirectory = instanceManager.getInstance(instanceId)?.workingDirectory;
            return workingDirectory
              ? `project:${createHash('sha256').update(path.resolve(workingDirectory)).digest('hex')}`
              : `instance:${instanceId}`;
          },
          autoApproveRequests: ({ instanceId }) =>
            Boolean(instanceManager.getInstance(instanceId)?.yoloMode),
        }),
    },
    {
      name: 'Desktop Computer Use Gateway',
      fn: async () => {
        try {
          await initializeDesktopGatewayRuntime({
            isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
          });
        } catch (error) {
          logger.warn('Desktop Computer Use gateway initialization failed; computer-use MCP will be unavailable', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    createOrchestratorToolsStep(instanceManager, windowManager),
    {
      name: 'Session admission service',
      fn: () => {
        // Wires the live InstanceManager so admitAutomatedWrite() can re-read
        // instance state and the redelivery listener can watch status edges.
        // Registration of per-origin redelivery handlers happens inside each
        // writer module (channel router, thread-wakeup runner, LSP feedback,
        // browser-gateway handlers, orchestration handler) — order relative to
        // those doesn't matter since they only resolve the singleton lazily at
        // call time.
        getSessionAdmissionService().setInstanceManager(instanceManager);
      },
    },
    {
      name: 'Codemem RPC server',
      fn: async () => {
        const { app } = await import('electron');
        await initializeCodememRpcServer({
          dbPath: path.join(app.getPath('userData'), 'codemem.sqlite'),
          userDataPath: app.getPath('userData'),
          isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
        });
      },
    },
    createCrossProjectPatternsStep(instanceManager),
  ];
}
