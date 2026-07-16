/**
 * Main Process Entry Point
 * Initializes the Electron application and all core services
 */

// Must be first — registers @contracts/@sdk/@shared path aliases for Node.js runtime
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./register-aliases');

import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { InstanceManager } from './instance/instance-manager';
import { getContextWorkerClient } from './instance/context-worker-client';
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
import { getThinClientWsServer } from './event-bus/thin-client-ws-server';
import { teardownAll } from './bootstrap';
import { BaseCliAdapter } from './cli/adapters/base-cli-adapter';
import { runCleanupFunctions } from './util/cleanup-registry';
import { providerAdapterRegistry } from './providers/provider-adapter-registry';
import { registerBuiltInProviders } from './providers/register-built-in-providers';
import { createInitializationSteps } from './app/initialization-steps';
import { resolveHarnessUserDataPath } from './app/user-data-path';
import { shutdownTracer } from './observability/otel-setup';
import { shutdownMetrics } from './observability/otel-metrics';
import { flushLifecycleTraces } from './observability/lifecycle-trace';
import { getChatServiceIfInitialized } from './chats';
import { shutdownCliSpawnWorkerGateway } from './cli/spawn-worker/cli-spawn-worker-gateway';
import {
  getGracefulShutdownManager,
  ShutdownPriority,
} from './process/graceful-shutdown';

// Register built-in provider adapters once at startup so the instance
// manager (and future consumers) can look them up by ProviderName.
registerBuiltInProviders(providerAdapterRegistry);

// Give the dev build its own identity so it can run alongside the installed
// production app: separate macOS Mach port namespace, separate single-instance
// lock, and a separate userData directory (so the two don't fight over the
// same SQLite session/history files). Must run before requestSingleInstanceLock
// and before any path lookups.
//
// The rebranded product's durable on-disk identity is lowercase "harness".
// Existing AI Orchestrator data is migrated into that directory out-of-band;
// startup should then read the new canonical location directly.
app.setPath('userData', resolveHarnessUserDataPath({
  appDataPath: app.getPath('appData'),
  isPackaged: app.isPackaged,
  env: process.env,
}));
if (!app.isPackaged) {
  app.setName('Harness (Dev)');
}

const logger = getLogger('App');

interface ShutdownAuditEntry {
  event: string;
  timestamp: number;
  pid: number;
  ppid: number;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  details?: Record<string, unknown>;
}

let shutdownTrigger: Record<string, unknown> | null = null;

function writeShutdownAudit(event: string, details?: Record<string, unknown>): void {
  const entry: ShutdownAuditEntry = {
    event,
    timestamp: Date.now(),
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    isPackaged: app.isPackaged,
    details,
  };

  try {
    const logsDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'shutdown.ndjson'), `${JSON.stringify(entry)}\n`, 'utf8');
  } catch {
    // Shutdown audit is best-effort; never block quit or startup on logging.
  }
}

function recordShutdownTrigger(source: string, details: Record<string, unknown> = {}): void {
  shutdownTrigger = {
    source,
    ...details,
    observedAt: Date.now(),
  };

  logger.warn('Shutdown trigger observed', shutdownTrigger);
  writeShutdownAudit('shutdown-trigger', shutdownTrigger);
}

class HarnessApp {
  private windowManager: WindowManager;
  private instanceManager: InstanceManager;
  private handlersRegistered = false;

  constructor() {
    this.windowManager = new WindowManager();
    // Route all RLM / unified-memory context work (build, init, ingest, compact)
    // through the context worker thread. Without this argument InstanceManager
    // falls back to the in-process InstanceContextManager, which runs synchronous
    // better-sqlite3 retrieval on the Electron main event loop and stalls the
    // whole app on send / new session (observed: a single RLM build blocking the
    // main thread for 38s, with multi-minute event-loop lag). Keep this wired.
    this.instanceManager = new InstanceManager(this.windowManager, getContextWorkerClient());
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Harness');

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

    logger.info('Harness initialized');
    if (
      app.isPackaged
      && process.env['AIO_STARTUP_SMOKE'] === '1'
      && process.env['AIO_STARTUP_SMOKE_USER_DATA_PATH']
    ) {
      fs.writeFileSync(
        path.join(process.env['AIO_STARTUP_SMOKE_USER_DATA_PATH'], 'startup-smoke-ready'),
        'Harness initialized\n',
        'utf8',
      );
      logger.info('Packaged startup smoke completed');
      setImmediate(() => app.quit());
    }
  }

  /**
   * Codex/Gemini adapters are currently exec-per-message (stateless).
   * Context threshold auto-guards are designed for stateful sessions.
   */
  private isStatelessExecProvider(provider: string | undefined): boolean {
    return provider === 'codex' || provider === 'gemini' || provider === 'antigravity';
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
    logger.info('Cleaning up');

    const report = await getGracefulShutdownManager().execute([
      {
        name: 'stop-remote-services',
        priority: ShutdownPriority.STOP_BACKGROUND,
        budgetMs: 1500,
        handler: async () => {
          try { getWorkerNodeHealth().stopAll(); } catch { /* best effort */ }
          try { getWorkerNodeConnectionServer().stop(); } catch { /* best effort */ }
          try { await getThinClientWsServer().stop(); } catch { /* best effort */ }
        },
      },
      {
        name: 'terminate-instances',
        priority: ShutdownPriority.TERMINATE_INSTANCES,
        budgetMs: 8000,
        handler: async () => {
          // CRITICAL: await terminateAll so every instance is archived to history
          // before the process exits. Without this, conversations are lost on quit.
          await this.instanceManager.terminateAll();
        },
      },
      {
        name: 'flush-chat-transcripts',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 1,
        budgetMs: 2000,
        handler: async () => {
          await getChatServiceIfInitialized()?.flushTranscript();
        },
      },
      {
        name: 'bootstrap-teardown',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 2,
        budgetMs: 3000,
        handler: teardownAll,
      },
      {
        name: 'flush-observability',
        priority: ShutdownPriority.TERMINATE_INSTANCES + 3,
        budgetMs: 2500,
        handler: async () => {
          await flushLifecycleTraces();
          await shutdownTracer();
          await shutdownMetrics();
        },
      },
      {
        name: 'cleanup-registry',
        priority: ShutdownPriority.FINAL_CLEANUP,
        budgetMs: 3000,
        handler: runCleanupFunctions,
      },
      {
        name: 'stop-cli-spawn-worker',
        priority: ShutdownPriority.FINAL_CLEANUP + 1,
        budgetMs: 3000,
        handler: shutdownCliSpawnWorkerGateway,
      },
      {
        name: 'kill-orphaned-cli-processes',
        priority: ShutdownPriority.FINAL_CLEANUP + 2,
        budgetMs: 4000,
        handler: () => BaseCliAdapter.killAllActiveProcessesGraceful(),
      },
    ]);

    const incomplete = report.phases.filter((phase) => phase.status !== 'completed');
    if (incomplete.length > 0) {
      logger.warn('Cleanup completed with incomplete shutdown phases', {
        phases: incomplete.map((phase) => ({
          name: phase.name,
          status: phase.status,
          durationMs: phase.durationMs,
          error: phase.error?.message,
        })),
      });
    }
    logger.info('Cleanup complete — all instances archived');
  }
}

// Prevent macOS Keychain popup for Chromium's encrypted storage.
// Without this, Electron triggers "Harness wants to use your
// confidential information stored in 'Harness Safe Storage'" on launch.
// `use-mock-keychain` is the macOS-specific switch; `password-store=basic` is Linux-only.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain');
} else if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'basic');
}

// Application instance
let orchestratorApp: HarnessApp | null = null;

// Enforce a single running instance.  Without this, macOS Launch Services
// will cheerfully spawn a second full app (each ~4 GB of RAM) when the user
// double-clicks the dock icon while the app is still starting up — you
// end up with two entries in Force Quit and two sets of processes fighting
// over the same session/SQLite files.  If we lose the lock, a prior
// instance is already running — focus its window via 'second-instance' and
// exit this process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  recordShutdownTrigger('single-instance-lock-failed', {
    argv: process.argv,
  });
  app.quit();
} else {
  app.on('second-instance', (_event, argv, workingDirectory) => {
    logger.info('Second app instance requested focus', {
      argv,
      workingDirectory,
    });

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

  orchestratorApp = new HarnessApp();
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
    recordShutdownTrigger('window-all-closed', {
      windowCount: BrowserWindow.getAllWindows().length,
    });
    app.quit();
  }
});

// Clean up before quit — must await async cleanup before the process exits,
// otherwise in-flight history archiving is silently dropped.
let cleanupDone = false;
const CLEANUP_TIMEOUT_MS = 10_000;

app.on('before-quit', (event) => {
  if (cleanupDone || !orchestratorApp) return;

  if (!shutdownTrigger) {
    recordShutdownTrigger('electron-before-quit', {
      windowCount: BrowserWindow.getAllWindows().length,
      argv: process.argv,
    });
  }

  writeShutdownAudit('before-quit', {
    cleanupDone,
    shutdownTrigger,
    windowCount: BrowserWindow.getAllWindows().length,
  });

  // Phase 1: Synchronous — guaranteed state save + process signaling
  orchestratorApp.cleanupSync();

  // Phase 2: Async — thorough cleanup with timeout
  event.preventDefault();
  cleanupDone = true;

  const timeout = setTimeout(() => {
    logger.warn('Cleanup timed out — forcing quit');
    writeShutdownAudit('cleanup-timeout', { shutdownTrigger });
    app.exit(0);
  }, CLEANUP_TIMEOUT_MS);

  orchestratorApp.cleanup()
    .catch((error) => {
      logger.error('Cleanup failed', error instanceof Error ? error : undefined);
    })
    .finally(() => {
      clearTimeout(timeout);
      writeShutdownAudit('cleanup-finished', { shutdownTrigger });
      app.quit();
    });
});

app.on('will-quit', () => {
  writeShutdownAudit('will-quit', { shutdownTrigger });
});

app.on('quit', (_event, exitCode) => {
  writeShutdownAudit('quit', { exitCode, shutdownTrigger });
});

process.on('exit', (code) => {
  writeShutdownAudit('process-exit', { code, shutdownTrigger });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error instanceof Error ? error : undefined);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason instanceof Error ? reason : undefined, { reason: String(reason) });
});
