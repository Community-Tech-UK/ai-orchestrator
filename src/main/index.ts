/**
 * Main Process Entry Point
 * Initializes the Electron application and all core services
 */

// Must be first — registers @contracts/@sdk/@shared path aliases for Node.js runtime
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./register-aliases');

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { InstanceManager } from './instance/instance-manager';
import { getLogger } from './logging/logger';
import {
  getSessionContinuityManagerIfInitialized,
} from './session/session-continuity';
import { getLoadBalancer } from './process/load-balancer';
import {
  getWorkerNodeRegistry,
  getWorkerNodeConnectionServer,
  getWorkerNodeHealth,
} from './remote-node';
import { teardownAll } from './bootstrap';
import { BaseCliAdapter } from './cli/adapters/base-cli-adapter';
import { runCleanupFunctions } from './util/cleanup-registry';
import { setGlobalState } from './state';
import { providerAdapterRegistry } from './providers/provider-adapter-registry';
import { registerBuiltInProviders } from './providers/register-built-in-providers';
import { createInitializationSteps } from './app/initialization-steps';
import { shutdownTracer } from './observability/otel-setup';

// Register built-in provider adapters once at startup so the instance
// manager (and future consumers) can look them up by ProviderName.
registerBuiltInProviders(providerAdapterRegistry);

// Give the dev build its own identity so it can run alongside the installed
// production app: separate macOS Mach port namespace, separate single-instance
// lock, and a separate userData directory (so the two don't fight over the
// same SQLite session/history files). Must run before requestSingleInstanceLock
// and before any path lookups.
if (!app.isPackaged) {
  app.setName('AI Orchestrator (Dev)');
  app.setPath('userData', path.join(app.getPath('appData'), 'AI Orchestrator (Dev)'));
}

const logger = getLogger('App');

class AIOrchestratorApp {
  private windowManager: WindowManager;
  private instanceManager: InstanceManager;
  private handlersRegistered = false;

  constructor() {
    this.windowManager = new WindowManager();
    this.instanceManager = new InstanceManager(this.windowManager);
  }

  async initialize(): Promise<void> {
    logger.info('Initializing AI Orchestrator');

    // Only register once — handlers persist across window recreation
    if (!this.handlersRegistered) {
      const steps = createInitializationSteps({
        instanceManager: this.instanceManager,
        windowManager: this.windowManager,
        isStatelessExecProvider: (provider) => this.isStatelessExecProvider(provider),
        getNodeLatencyForInstance: (instanceId) => this.getNodeLatencyForInstance(instanceId),
        syncRemoteNodeMetricsToLoadBalancer: (nodeId) => this.syncRemoteNodeMetricsToLoadBalancer(nodeId),
      });

      for (const step of steps) {
        try {
          logger.info(`Initializing: ${step.name}`);
          await step.fn();
          logger.info(`Initialized: ${step.name}`);
        } catch (error) {
          logger.error(`Failed to initialize: ${step.name}`, error instanceof Error ? error : undefined);
          if (step.critical) {
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
    try { getWorkerNodeHealth().stopAll(); } catch { /* best effort */ }
    try { getWorkerNodeConnectionServer().stop(); } catch { /* best effort */ }

    // CRITICAL: await terminateAll so every instance is archived to history
    // before the process exits. Without this, conversations are lost on quit.
    await this.instanceManager.terminateAll();
    // Run registered domain teardowns before the generic cleanup registry so
    // teardown order remains explicit for bootstrap-managed services.
    await teardownAll();
    await shutdownTracer();
    // Session state already saved synchronously in cleanupSync()
    await runCleanupFunctions();
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

// Enforce a single running instance.  Without this, macOS Launch Services
// will cheerfully spawn a second full app (each ~4 GB of RAM) when the user
// double-clicks the dock icon while the app is still starting up — you
// end up with two entries in Force Quit and two sets of processes fighting
// over the same session/SQLite files.  If we lose the lock, a prior
// instance is already running — focus its window via 'second-instance' and
// exit this process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const windows = BrowserWindow.getAllWindows();
    const mainWindow = windows[0];
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

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
