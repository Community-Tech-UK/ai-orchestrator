/**
 * Main Process Entry Point
 * Initializes the Electron application and all core services
 */

import { app, BrowserWindow, powerMonitor } from 'electron';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { IpcMainHandler } from './ipc/ipc-main-handler';
import { InstanceManager } from './instance/instance-manager';
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
import type { UserActionRequest } from './orchestration/orchestration-handler';
import { getCrossModelReviewService } from './orchestration/cross-model-review-service';
import { registerCrossModelReviewIpcHandlers } from './ipc/cross-model-review-ipc';
import { getChannelManager } from './channels';

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
        { name: 'Plugin manager', fn: () => getOrchestratorPluginManager().initialize(this.instanceManager) },
        { name: 'Observation ingestor', fn: () => getObservationIngestor().initialize(this.instanceManager) },
        { name: 'Observer agent', fn: () => { getObserverAgent(); } },
        { name: 'Reflector agent', fn: () => { getReflectorAgent(); } },
        { name: 'Path validator', fn: () => initializePathValidator() },
        { name: 'Compaction coordinator', fn: () => this.setupCompactionCoordinator() },
        { name: 'Doom loop detector', fn: () => { getDoomLoopDetector(); } },
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
        { name: 'Cross-model review', fn: async () => {
          const crossModelReview = getCrossModelReviewService();
          await crossModelReview.initialize();
          registerCrossModelReviewIpcHandlers();
        } },
        { name: 'Channel manager', fn: () => { getChannelManager(); } },
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

    this.instanceManager.on('instance:output', (output) => {
      this.windowManager.sendToRenderer('instance:output', output);
      observer.publishInstanceOutput(output.instanceId, output.message);
      // Track output for session continuity
      try {
        const continuity = getSessionContinuityManager();
        const instance = this.instanceManager.getInstance(output.instanceId);
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
          continuity.updateState(output.instanceId, stateUpdate);
        }
        const msg = output.message;
        if (msg && (msg.type === 'user' || msg.type === 'assistant' || msg.type === 'tool_use' || msg.type === 'tool_result')) {
          continuity.addConversationEntry(output.instanceId, {
            id: msg.id || `msg-${Date.now()}`,
            role: msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : 'tool',
            content: msg.content || '',
            timestamp: msg.timestamp || Date.now(),
          });
        }
      } catch {
        logger.warn('Failed to track conversation entry', { instanceId: output.instanceId });
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
            });
          }
        }
      }
    });

    // Wire instance events to cross-model review
    const crossModelReview = getCrossModelReviewService();

    this.instanceManager.on('instance:output', ({ instanceId, message }) => {
      if (message.metadata?.source === 'cross-model-review') return;
      const instance = this.instanceManager.getInstance(instanceId);
      const provider = instance?.provider ?? 'claude';
      const firstUserPrompt = instance?.displayName ?? '';
      crossModelReview.bufferMessage(instanceId, message.type, message.content, provider as string, firstUserPrompt);
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
          // Emit as output so the renderer picks it up via the normal output pipeline
          this.instanceManager.emit('instance:output', {
            instanceId,
            message: boundaryMessage,
          });
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

  cleanup(): void {
    logger.info('Cleaning up');
    try { getResourceGovernor().stop(); } catch { /* best effort */ }
    try { getHibernationManager().stop(); } catch { /* best effort */ }
    try { getPoolManager().stop(); } catch { /* best effort */ }
    try { getCrossModelReviewService().shutdown(); } catch { /* best effort */ }
    // Save all tracked session states before terminating
    try {
      getSessionContinuityManagerIfInitialized()?.shutdown();
    } catch (error) {
      logger.error('Failed to save sessions on shutdown', error instanceof Error ? error : undefined);
    }
    void (async () => {
      try { await getChannelManager().shutdown(); } catch { /* best effort */ }
    })();
    this.instanceManager.terminateAll();
  }
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

// Clean up before quit
app.on('before-quit', () => {
  orchestratorApp?.cleanup();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error instanceof Error ? error : undefined);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : undefined, { reason: String(reason) });
});
