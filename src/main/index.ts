/**
 * Main Process Entry Point
 * Initializes the Electron application and all core services
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { WindowManager } from './window-manager';
import { IpcMainHandler } from './ipc/ipc-main-handler';
import { InstanceManager } from './instance/instance-manager';
import { getHookManager } from './hooks/hook-manager';
import { registerDefaultMultiVerifyInvoker, registerDefaultReviewInvoker } from './orchestration/default-invokers';
import { getOrchestratorPluginManager } from './plugins/plugin-manager';
import { getObservationIngestor, getObserverAgent, getReflectorAgent } from './observation';

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
    console.log('Initializing AI Orchestrator...');

    // Register IPC handlers BEFORE creating window
    // (window might call handlers immediately on load)
    // Only register once - handlers persist across window recreation
    if (!this.handlersRegistered) {
      this.ipcHandler.registerHandlers();
      this.handlersRegistered = true;

      // Load persisted hook approvals (only once)
      await getHookManager().loadApprovals();

      // Set up instance manager event forwarding to renderer (only once)
      this.setupInstanceEventForwarding();

      // Wire up default multi-agent invokers (only once)
      registerDefaultMultiVerifyInvoker(this.instanceManager);
      registerDefaultReviewInvoker(this.instanceManager);

      // Load/dispatch plugins (only once)
      getOrchestratorPluginManager().initialize(this.instanceManager);

      // Initialize observation memory subsystem (only once)
      getObservationIngestor().initialize(this.instanceManager);
      getObserverAgent();
      getReflectorAgent();
    }

    // Create main window (this loads the renderer which may call IPC)
    await this.windowManager.createMainWindow();

    console.log('AI Orchestrator initialized');
  }

  private setupInstanceEventForwarding(): void {
    // Forward instance events to renderer
    this.instanceManager.on('instance:created', (instance) => {
      this.windowManager.sendToRenderer('instance:created', instance);
    });

    this.instanceManager.on('instance:removed', (instanceId) => {
      this.windowManager.sendToRenderer('instance:removed', instanceId);
    });

    this.instanceManager.on('instance:state-update', (update) => {
      this.windowManager.sendToRenderer('instance:state-update', update);
    });

    this.instanceManager.on('instance:output', (output) => {
      this.windowManager.sendToRenderer('instance:output', output);
    });

    this.instanceManager.on('instance:batch-update', (updates) => {
      this.windowManager.sendToRenderer('instance:batch-update', updates);
    });

    // Forward input-required events (permission prompts) to renderer
    this.instanceManager.on('instance:input-required', (payload) => {
      console.log('=== [MainApp] FORWARDING INPUT_REQUIRED TO RENDERER ===');
      console.log('[MainApp] Payload:', JSON.stringify(payload, null, 2));
      console.log('[MainApp] WindowManager ready:', !!this.windowManager);
      this.windowManager.sendToRenderer('instance:input-required', payload);
      console.log('[MainApp] sendToRenderer called for instance:input-required');
      console.log('=== [MainApp] FORWARD COMPLETE ===');
    });

    // Forward user action requests from orchestrator to renderer
    const orchestration = this.instanceManager.getOrchestrationHandler();
    orchestration.on('user-action-request', (request) => {
      console.log('Forwarding user action request to renderer:', request.id);
      this.windowManager.sendToRenderer('user-action:request', request);
    });
  }

  cleanup(): void {
    console.log('Cleaning up...');
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
    } catch (e) {
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
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
