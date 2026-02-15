/**
 * IPC Main Handler - Slim Coordinator
 * Registers all IPC handlers and manages event forwarding
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import * as crypto from 'crypto';
import { InstanceManager } from '../instance/instance-manager';
import { WindowManager } from '../window-manager';
import { IPC_CHANNELS, IpcResponse } from '../../shared/types/ipc.types';
import { registerOrchestrationHandlers } from './orchestration-ipc-handler';
import { registerVerificationHandlers } from './verification-ipc-handler';
import { registerCliVerificationHandlers } from './cli-verification-ipc-handler';
import { registerLearningHandlers } from './learning-ipc-handler';
import { registerMemoryHandlers } from './memory-ipc-handler';
import { registerSpecialistHandlers } from './specialist-ipc-handler';
import { registerTrainingHandlers } from './training-ipc-handler';
import { registerLLMHandlers } from './llm-ipc-handler';
import { registerObservationHandlers } from './observation-ipc-handler';
import { RLMContextManager } from '../rlm/context-manager';

// Import extracted handlers
import {
  registerInstanceHandlers,
  registerSettingsHandlers,
  registerSessionHandlers,
  registerProviderHandlers,
  registerVcsHandlers,
  registerLspHandlers,
  registerSnapshotHandlers,
  registerMcpHandlers,
  registerTodoHandlers,
  registerSecurityHandlers,
  registerDebugHandlers,
  registerCostHandlers,
  registerTaskHandlers,
  registerSearchHandlers,
  registerStatsHandlers,
  registerCommandHandlers,
  registerAppHandlers,
  registerFileHandlers,
  registerCodebaseHandlers,
  registerSupervisionHandlers,
  registerRecentDirectoriesHandlers,
  registerEcosystemHandlers
} from './handlers';

export class IpcMainHandler {
  private instanceManager: InstanceManager;
  private windowManager: WindowManager;
  private ipcRateLimits: Map<string, number> = new Map();
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

  private enforceRateLimit(
    event: IpcMainInvokeEvent,
    channel: string,
    minIntervalMs: number
  ): IpcResponse | null {
    const key = `${event.sender.id}:${channel}`;
    const now = Date.now();
    const last = this.ipcRateLimits.get(key);
    if (last && now - last < minIntervalMs) {
      return {
        success: false,
        error: {
          code: 'IPC_RATE_LIMITED',
          message: `Rate limited: ${channel}`,
          timestamp: now
        }
      };
    }
    this.ipcRateLimits.set(key, now);
    return null;
  }

  /**
   * Register all IPC handlers
   */
  registerHandlers(): void {
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

    // Settings, config, and remote config handlers
    registerSettingsHandlers({ windowManager: this.windowManager });

    // Memory stats handlers (basic memory tracking)
    this.registerMemoryStatsHandlers();

    // Session, archive, and history handlers
    registerSessionHandlers({
      instanceManager: this.instanceManager,
      serializeInstance: this.serializeInstance.bind(this)
    });

    // Provider and plugin handlers
    registerProviderHandlers({
      windowManager: this.windowManager,
      ensureAuthorized: this.ensureAuthorized.bind(this)
    });

    // Command and plan mode handlers
    registerCommandHandlers(this.instanceManager);

    // VCS handlers (Git integration)
    registerVcsHandlers();

    // Snapshot handlers (File revert)
    registerSnapshotHandlers();

    // TODO handlers
    registerTodoHandlers({ windowManager: this.windowManager });

    // MCP handlers
    registerMcpHandlers({ windowManager: this.windowManager });

    // LSP handlers
    registerLspHandlers();

    // File handlers (editor, watcher, multi-edit)
    registerFileHandlers({ windowManager: this.windowManager });

    // Task management handlers (subagent spawning)
    registerTaskHandlers();

    // Security handlers (secret detection, env filtering, bash validation)
    registerSecurityHandlers();

    // Cost tracking handlers
    registerCostHandlers({ windowManager: this.windowManager });

    // Debug command handlers
    registerDebugHandlers();

    // Usage stats handlers
    registerStatsHandlers();

    // Semantic search handlers
    registerSearchHandlers();

    // Codebase indexing handlers
    registerCodebaseHandlers(this.windowManager);

    // Orchestration handlers (Phase 6: Workflows, Hooks, Skills)
    registerOrchestrationHandlers(this.instanceManager);

    // Ecosystem handlers (file-based commands/agents/tools/plugins)
    registerEcosystemHandlers(this.instanceManager);

    // User action request handlers (orchestrator -> user communication)
    this.registerUserActionHandlers();

    // Verification handlers (Worktree, Verification, Supervision)
    registerVerificationHandlers();

    // CLI Verification handlers (Multi-CLI detection and verification)
    registerCliVerificationHandlers(this.windowManager);

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

    // Recent directories handlers
    registerRecentDirectoriesHandlers();

    // Set up memory event forwarding to renderer
    this.setupMemoryEventForwarding();
    this.setupRlmEventForwarding();

    console.log('IPC handlers registered');
  }

  /**
   * Register user action request handlers
   * These allow orchestrators to request user actions like approvals, confirmations, etc.
   */
  private registerUserActionHandlers(): void {
    // Handle permission request from orchestrator
    ipcMain.handle(
      IPC_CHANNELS.USER_ACTION_REQUEST,
      async (
        event: IpcMainInvokeEvent,
        payload: {
          instanceId: string;
          action: string;
          description: string;
          metadata?: Record<string, unknown>;
        }
      ): Promise<IpcResponse> => {
        try {
          // Forward the permission request to the renderer
          // The renderer will show a UI prompt and send back the response
          const mainWindow = this.windowManager.getMainWindow();
          if (!mainWindow) {
            return {
              success: false,
              error: {
                code: 'NO_WINDOW',
                message: 'No main window available',
                timestamp: Date.now()
              }
            };
          }

          // Send the permission request to renderer and wait for response
          return new Promise((resolve) => {
            const requestId = crypto.randomUUID();

            // Set up one-time listener for the response
            const responseChannel = `user-action-response:${requestId}`;
            ipcMain.once(
              responseChannel,
              (_, response: { approved: boolean; reason?: string }) => {
                resolve({
                  success: true,
                  data: response
                });
              }
            );

            // Send request to renderer
            mainWindow.webContents.send('user-action-request', {
              requestId,
              instanceId: payload.instanceId,
              action: payload.action,
              description: payload.description,
              metadata: payload.metadata
            });

            // Timeout after 5 minutes
            setTimeout(() => {
              ipcMain.removeAllListeners(responseChannel);
              resolve({
                success: false,
                error: {
                  code: 'TIMEOUT',
                  message: 'Permission request timed out',
                  timestamp: Date.now()
                }
              });
            }, 5 * 60 * 1000);
          });
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PERMISSION_REQUEST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now()
            }
          };
        }
      }
    );

    // Handle sending user action response from renderer
    ipcMain.on(
      'user-action-response',
      (
        event: IpcMainInvokeEvent,
        payload: { requestId: string; approved: boolean; reason?: string }
      ) => {
        // Forward the response to the waiting handler
        event.sender.send(`user-action-response:${payload.requestId}`, {
          approved: payload.approved,
          reason: payload.reason
        });
      }
    );
  }

  private registerMemoryStatsHandlers(): void {
    // Get memory stats
    ipcMain.handle(
      IPC_CHANNELS.MEMORY_GET_STATS,
      async (): Promise<IpcResponse> => {
        try {
          const stats = this.instanceManager.getMemoryStats();
          return {
            success: true,
            data: stats
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MEMORY_STATS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now()
            }
          };
        }
      }
    );

    // Load historical output from disk
    ipcMain.handle(
      IPC_CHANNELS.MEMORY_LOAD_HISTORY,
      async (
        event: IpcMainInvokeEvent,
        payload: { instanceId: string; limit?: number }
      ): Promise<IpcResponse> => {
        try {
          const messages = await this.instanceManager.loadHistoricalOutput(
            payload.instanceId,
            payload.limit
          );
          return {
            success: true,
            data: messages
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOAD_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now()
            }
          };
        }
      }
    );
  }

  /**
   * Set up memory event forwarding to renderer
   */
  private setupMemoryEventForwarding(): void {
    // Forward memory stats updates to renderer
    this.instanceManager.on('memory:stats', (stats) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send(IPC_CHANNELS.MEMORY_STATS_UPDATE, stats);
    });

    // Forward memory warnings
    this.instanceManager.on('memory:warning', (stats) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send(IPC_CHANNELS.MEMORY_WARNING, {
          ...stats,
          message: `Memory usage warning: ${stats.heapUsedMB}MB heap used`
        });
    });

    // Forward critical memory alerts
    this.instanceManager.on('memory:critical', (stats) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send(IPC_CHANNELS.MEMORY_CRITICAL, {
          ...stats,
          message: `Critical memory usage: ${stats.heapUsedMB}MB heap used. Idle instances may be terminated.`
        });
    });
  }

  /**
   * Set up RLM event forwarding to renderer
   */
  private setupRlmEventForwarding(): void {
    const rlm = RLMContextManager.getInstance();

    rlm.on('store:created', (store) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:store-updated', {
          storeId: store.id,
          store
        });
    });

    rlm.on('section:added', ({ store, section }) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:section-added', {
          storeId: store.id,
          section
        });
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:store-updated', {
          storeId: store.id,
          store
        });
    });

    rlm.on('section:removed', ({ store, section }) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:section-removed', {
          storeId: store.id,
          sectionId: section.id
        });
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:store-updated', {
          storeId: store.id,
          store
        });
    });

    rlm.on('query:executed', ({ session, queryResult }) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:query-complete', {
          sessionId: session.id,
          queryResult
        });
    });

    rlm.on('summary:created', ({ storeId, section }) => {
      this.windowManager
        .getMainWindow()
        ?.webContents.send('rlm:section-added', {
          storeId,
          section
        });
    });
  }


  private serializeInstance(instance: any): Record<string, unknown> {
    return {
      ...instance,
      communicationTokens:
        instance.communicationTokens instanceof Map
          ? Object.fromEntries(instance.communicationTokens)
          : instance.communicationTokens
    };
  }
}
