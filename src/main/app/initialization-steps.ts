import { app } from 'electron';
import { getHookManager } from '../hooks/hook-manager';
import {
  registerDefaultMultiVerifyInvoker,
  registerDefaultReviewInvoker,
  registerDefaultDebateInvoker,
  registerDefaultWorkflowInvoker,
} from '../orchestration/default-invokers';
import { getLogger } from '../logging/logger';
import { getRemoteObserverServer } from '../remote/observer-server';
import { getProviderEventCaptureService } from '../conversation-ledger/provider-event-capture-service';
import { initializeProviderEventCaptureMaintenance } from '../conversation-ledger/provider-event-capture-maintenance';
import { getGovernedProposalService } from '../memory/governed-proposal-service';
import { getCodemem } from '../codemem';
import { initializeAutomations } from '../automations';
import { installRuntimeDiagnostics } from './runtime-diagnostics';
import { setupInstanceEventForwarding } from './instance-event-forwarding';
import { initializePauseFeatureRuntime } from './pause-feature-bootstrap';
import { initializeMainProcessWatchdog } from '../runtime/main-process-watchdog';
import { getEventLoopLagMonitor } from '../runtime/event-loop-lag-monitor';
import { getContextWorkerClient } from '../instance/context-worker-client';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import { getSettingsManager } from '../core/config/settings-manager';
import { getProviderQuotaService } from '../core/system/provider-quota-service';
import { initializeUnifiedModelCatalogRuntime } from './unified-model-catalog-initialization';
import { maybeStartWorkerModeOnLaunch } from '../remote-node/worker-mode-autostart';
import { initializeContextEvidenceRuntime } from '../context-evidence/evidence-maintenance-service';
import { initializeLocalAiGuardRuntime } from '../local-ai-guard';
import { initializeInstanceAsyncWorkContinuation } from '../instance/instance-async-work-continuation';
import { createLateRuntimeInitializationSteps } from './late-runtime-initialization-steps';

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

export function createContextEvidenceInitializationStep(
  initialize: () => Promise<void> = initializeContextEvidenceRuntime,
): AppInitializationStep {
  return {
    name: 'Context evidence',
    fn: async () => {
      try {
        await initialize();
      } catch (error) {
        logger.warn('Context evidence initialization failed; durable capture remains unavailable', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

export function createLocalAiGuardInitializationStep(
  initialize: () => unknown = initializeLocalAiGuardRuntime,
): AppInitializationStep {
  return {
    name: 'Local AI Guard',
    fn: () => {
      try {
        initialize();
      } catch {
        logger.warn('Local AI Guard initialization failed; local routing remains unavailable', {
          reason: 'runtime-startup-error',
        });
      }
    },
  };
}

/** WS-A4: rehydrate approved memory proposals into LessonStore + one-time backfill. Fail-soft. */
export function createGovernedProposalInitializationStep(
  service: () => { initialize: () => void } = getGovernedProposalService,
): AppInitializationStep {
  return { name: 'Governed proposal review inbox', fn: () => {
    try { service().initialize(); } catch (error) {
      logger.warn('Governed proposal initialization failed', { error: error instanceof Error ? error.message : String(error) });
    }
  } };
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
    createContextEvidenceInitializationStep(),
    {
      name: 'Provider event capture',
      fn: () => {
        try {
          getProviderEventCaptureService().start(instanceManager);
          initializeProviderEventCaptureMaintenance();
        } catch (error) {
          logger.warn('Provider event capture initialization failed; fixture capture is unavailable this session', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Context analytics',
      fn: () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { wireContextAnalytics } = require('../context/context-analytics-wiring') as typeof import('../context/context-analytics-wiring');
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { getSettingsManager } = require('../core/config/settings-manager') as typeof import('../core/config/settings-manager');
          wireContextAnalytics({
            instanceEvents: instanceManager,
            settingsEvents: getSettingsManager(),
          });
        } catch (error) {
          logger.warn('Context analytics wiring failed; cache-break correlation is unavailable this session', {
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
          const { getOperatorDatabase, getProjectRegistry } = require('../operator') as typeof import('../operator');
          getOperatorDatabase();
          getProjectRegistry({ instanceManager });
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
      // Initialise the unified model catalog and kick off a background models.dev
      // sync.  The runtime helper awaits local/remote override source startup
      // before attaching those entries to the catalog, so cold-start launches
      // validate against configured override-only models instead of racing the
      // async source loaders. The catalog is still fail-soft: a source failure
      // leaves the static snapshot in place.
      name: 'Unified model catalog',
      fn: async () => {
        try {
          await initializeUnifiedModelCatalogRuntime({
            userDataPath: app.getPath('userData'),
          });
        } catch (error) {
          logger.warn('Unified model catalog initialization failed; catalog will use static fallback', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    {
      name: 'Auxiliary LLM service',
      fn: () => {
        try {
          const settings = getSettingsManager();
          const applyAuxiliaryConfig = () => {
            try {
              getAuxiliaryLlmService().configure({
                auxiliaryLlmEnabled: settings.get('auxiliaryLlmEnabled'),
                auxiliaryLlmRoutingMode: settings.get('auxiliaryLlmRoutingMode'),
                auxiliaryLlmAllowRemoteWorkerModels: settings.get('auxiliaryLlmAllowRemoteWorkerModels'),
                auxiliaryLlmUseLocalhostOllama: settings.get('auxiliaryLlmUseLocalhostOllama'),
                auxiliaryLlmDailySpendCapUsd: settings.get('auxiliaryLlmDailySpendCapUsd'),
                auxiliaryLlmEndpointsJson: settings.get('auxiliaryLlmEndpointsJson'),
                auxiliaryLlmSlotsJson: settings.get('auxiliaryLlmSlotsJson'),
                auxiliaryLlmQuickModel: settings.get('auxiliaryLlmQuickModel'),
                auxiliaryLlmQualityModel: settings.get('auxiliaryLlmQualityModel'),
              });
            } catch (err) {
              logger.warn('Failed to apply auxiliary LLM config', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          };
          applyAuxiliaryConfig();
          settings.on('setting-changed', applyAuxiliaryConfig);
        } catch (error) {
          logger.warn('Auxiliary LLM service initialization failed; helper calls will use primary LLM', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    },
    createLocalAiGuardInitializationStep(),
    {
      name: 'Quota pacing',
      fn: () => {
        try {
          const settings = getSettingsManager();
          const applyQuotaPacingConfig = () => {
            getProviderQuotaService().configurePacing({
              enabled: settings.get('quotaPacingWarningEnabled'),
              utilizationThresholdPercent: settings.get('quotaPacingUtilizationThresholdPercent'),
              latestElapsedPercent: settings.get('quotaPacingLatestElapsedPercent'),
            });
          };
          applyQuotaPacingConfig();
          settings.on('setting-changed', applyQuotaPacingConfig);
        } catch (error) {
          logger.warn('Quota pacing initialization failed; default pacing thresholds remain active', {
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
    { name: 'Worker mode autostart', fn: () => { maybeStartWorkerModeOnLaunch(); } },
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
    {
      name: 'Background task continuation',
      fn: () => { initializeInstanceAsyncWorkContinuation(instanceManager); },
    },
    { name: 'Verification invokers', fn: () => registerDefaultMultiVerifyInvoker(instanceManager) },
    { name: 'Automations', fn: () => initializeAutomations(instanceManager) },
    { name: 'Review invokers', fn: () => registerDefaultReviewInvoker(instanceManager) },
    { name: 'Debate invokers', fn: () => registerDefaultDebateInvoker(instanceManager) },
    { name: 'Workflow invokers', fn: () => registerDefaultWorkflowInvoker(instanceManager) },
    ...createLateRuntimeInitializationSteps(context),
    createGovernedProposalInitializationStep(),
  ];
}
