/**
 * IPC Main Handler - Handles IPC communication from renderer
 */

import { ipcMain, IpcMainInvokeEvent, dialog } from 'electron';
import { InstanceManager } from '../instance/instance-manager';
import { WindowManager } from '../window-manager';
import { getSettingsManager } from '../settings/settings-manager';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { detectAvailableClis, isCliAvailable, CliType } from '../cli/cli-detector';
import type {
  InstanceCreatePayload,
  InstanceSendInputPayload,
  InstanceTerminatePayload,
  InstanceRestartPayload,
  InstanceRenamePayload,
  SettingsSetPayload,
  SettingsUpdatePayload,
  SettingsResetOnePayload,
  HistoryListPayload,
  HistoryLoadPayload,
  HistoryDeletePayload,
  HistoryRestorePayload,
  IpcResponse,
} from '../../shared/types/ipc.types';
import type { AppSettings } from '../../shared/types/settings.types';
import { getHistoryManager } from '../history';

export class IpcMainHandler {
  private instanceManager: InstanceManager;
  private windowManager: WindowManager;

  constructor(instanceManager: InstanceManager, windowManager: WindowManager) {
    this.instanceManager = instanceManager;
    this.windowManager = windowManager;
  }

  /**
   * Register all IPC handlers
   */
  registerHandlers(): void {
    // Instance management handlers
    this.registerInstanceHandlers();

    // App handlers
    this.registerAppHandlers();

    // Settings handlers
    this.registerSettingsHandlers();

    // Memory handlers
    this.registerMemoryHandlers();

    // History handlers
    this.registerHistoryHandlers();

    // Set up memory event forwarding to renderer
    this.setupMemoryEventForwarding();

    console.log('IPC handlers registered');
  }

  /**
   * Register instance-related handlers
   */
  private registerInstanceHandlers(): void {
    // Create instance
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_CREATE,
      async (event: IpcMainInvokeEvent, payload: InstanceCreatePayload): Promise<IpcResponse> => {
        try {
          const instance = await this.instanceManager.createInstance({
            workingDirectory: payload.workingDirectory,
            sessionId: payload.sessionId,
            parentId: payload.parentInstanceId,
            displayName: payload.displayName,
            initialPrompt: payload.initialPrompt,
            attachments: payload.attachments,
            yoloMode: payload.yoloMode,
          });

          return {
            success: true,
            data: this.serializeInstance(instance),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CREATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Send input to instance
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_SEND_INPUT,
      async (event: IpcMainInvokeEvent, payload: InstanceSendInputPayload): Promise<IpcResponse> => {
        console.log('IPC INSTANCE_SEND_INPUT received:', {
          instanceId: payload.instanceId,
          messageLength: payload.message?.length,
          attachmentsCount: payload.attachments?.length ?? 0,
          attachmentNames: payload.attachments?.map(a => a.name)
        });
        try {
          await this.instanceManager.sendInput(
            payload.instanceId,
            payload.message,
            payload.attachments
          );

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEND_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Terminate instance
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_TERMINATE,
      async (event: IpcMainInvokeEvent, payload: InstanceTerminatePayload): Promise<IpcResponse> => {
        try {
          await this.instanceManager.terminateInstance(
            payload.instanceId,
            payload.graceful ?? true
          );

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TERMINATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Restart instance
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_RESTART,
      async (event: IpcMainInvokeEvent, payload: InstanceRestartPayload): Promise<IpcResponse> => {
        try {
          await this.instanceManager.restartInstance(payload.instanceId);

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'RESTART_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Rename instance
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_RENAME,
      async (event: IpcMainInvokeEvent, payload: InstanceRenamePayload): Promise<IpcResponse> => {
        try {
          this.instanceManager.renameInstance(payload.instanceId, payload.displayName);

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'RENAME_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Terminate all instances
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_TERMINATE_ALL,
      async (): Promise<IpcResponse> => {
        try {
          await this.instanceManager.terminateAllInstances();

          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TERMINATE_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get all instances
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_LIST,
      async (): Promise<IpcResponse> => {
        try {
          const instances = this.instanceManager.getAllInstancesForIpc();

          return {
            success: true,
            data: instances,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register app-related handlers
   */
  private registerAppHandlers(): void {
    // App ready signal
    ipcMain.handle(IPC_CHANNELS.APP_READY, async (): Promise<IpcResponse> => {
      return {
        success: true,
        data: {
          version: '0.1.0',
          platform: process.platform,
        },
      };
    });

    // Get app version
    ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async (): Promise<IpcResponse> => {
      return {
        success: true,
        data: '0.1.0',
      };
    });

    // Detect all available CLIs
    ipcMain.handle(IPC_CHANNELS.CLI_DETECT_ALL, async (): Promise<IpcResponse> => {
      try {
        const clis = await detectAvailableClis();
        return {
          success: true,
          data: clis,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'CLI_DETECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    });

    // Check specific CLI
    ipcMain.handle(
      IPC_CHANNELS.CLI_CHECK,
      async (event: IpcMainInvokeEvent, cliType: string): Promise<IpcResponse> => {
        try {
          const cli = await isCliAvailable(cliType as CliType);
          return {
            success: true,
            data: cli,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CLI_CHECK_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Open folder selection dialog
    ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async (): Promise<IpcResponse> => {
      try {
        const result = await dialog.showOpenDialog({
          properties: ['openDirectory'],
          title: 'Select Working Folder',
          buttonLabel: 'Select Folder',
        });

        if (result.canceled || result.filePaths.length === 0) {
          return {
            success: true,
            data: null, // User cancelled
          };
        }

        return {
          success: true,
          data: result.filePaths[0],
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'DIALOG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    });
  }

  /**
   * Register settings-related handlers
   */
  private registerSettingsHandlers(): void {
    const settings = getSettingsManager();

    // Get all settings
    ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_ALL, async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: settings.getAll(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_GET_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    });

    // Get single setting
    ipcMain.handle(
      IPC_CHANNELS.SETTINGS_GET,
      async (event: IpcMainInvokeEvent, key: string): Promise<IpcResponse> => {
        try {
          return {
            success: true,
            data: settings.get(key as keyof AppSettings),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SETTINGS_GET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Set single setting
    ipcMain.handle(
      IPC_CHANNELS.SETTINGS_SET,
      async (event: IpcMainInvokeEvent, payload: SettingsSetPayload): Promise<IpcResponse> => {
        try {
          settings.set(payload.key as keyof AppSettings, payload.value as any);
          // Notify renderer of change
          this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            key: payload.key,
            value: payload.value,
          });
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SETTINGS_SET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update multiple settings
    ipcMain.handle(
      IPC_CHANNELS.SETTINGS_UPDATE,
      async (event: IpcMainInvokeEvent, payload: SettingsUpdatePayload): Promise<IpcResponse> => {
        try {
          settings.update(payload.settings as Partial<AppSettings>);
          // Notify renderer of changes
          this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            settings: settings.getAll(),
          });
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SETTINGS_UPDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Reset all settings
    ipcMain.handle(IPC_CHANNELS.SETTINGS_RESET, async (): Promise<IpcResponse> => {
      try {
        settings.reset();
        // Notify renderer
        this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
          settings: settings.getAll(),
        });
        return {
          success: true,
          data: settings.getAll(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'SETTINGS_RESET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    });

    // Reset single setting
    ipcMain.handle(
      IPC_CHANNELS.SETTINGS_RESET_ONE,
      async (event: IpcMainInvokeEvent, payload: SettingsResetOnePayload): Promise<IpcResponse> => {
        try {
          settings.resetOne(payload.key as keyof AppSettings);
          const value = settings.get(payload.key as keyof AppSettings);
          // Notify renderer
          this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED, {
            key: payload.key,
            value,
          });
          return {
            success: true,
            data: value,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SETTINGS_RESET_ONE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register memory-related handlers
   */
  private registerMemoryHandlers(): void {
    // Get memory stats
    ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async (): Promise<IpcResponse> => {
      try {
        const stats = this.instanceManager.getMemoryStats();
        return {
          success: true,
          data: stats,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MEMORY_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    });

    // Load historical output from disk
    ipcMain.handle(
      IPC_CHANNELS.MEMORY_LOAD_HISTORY,
      async (event: IpcMainInvokeEvent, payload: { instanceId: string; limit?: number }): Promise<IpcResponse> => {
        try {
          const messages = await this.instanceManager.loadHistoricalOutput(
            payload.instanceId,
            payload.limit
          );
          return {
            success: true,
            data: messages,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOAD_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
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
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MEMORY_STATS_UPDATE,
        stats
      );
    });

    // Forward memory warnings
    this.instanceManager.on('memory:warning', (stats) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MEMORY_WARNING,
        {
          ...stats,
          message: `Memory usage warning: ${stats.heapUsedMB}MB heap used`,
        }
      );
    });

    // Forward critical memory alerts
    this.instanceManager.on('memory:critical', (stats) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MEMORY_CRITICAL,
        {
          ...stats,
          message: `Critical memory usage: ${stats.heapUsedMB}MB heap used. Idle instances may be terminated.`,
        }
      );
    });
  }

  /**
   * Register history-related handlers
   */
  private registerHistoryHandlers(): void {
    const history = getHistoryManager();

    // List history entries
    ipcMain.handle(
      IPC_CHANNELS.HISTORY_LIST,
      async (event: IpcMainInvokeEvent, payload: HistoryListPayload): Promise<IpcResponse> => {
        try {
          const entries = history.getEntries(payload);
          return {
            success: true,
            data: entries,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'HISTORY_LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Load full conversation data
    ipcMain.handle(
      IPC_CHANNELS.HISTORY_LOAD,
      async (event: IpcMainInvokeEvent, payload: HistoryLoadPayload): Promise<IpcResponse> => {
        try {
          const data = await history.loadConversation(payload.entryId);
          if (!data) {
            return {
              success: false,
              error: {
                code: 'HISTORY_NOT_FOUND',
                message: `History entry ${payload.entryId} not found`,
                timestamp: Date.now(),
              },
            };
          }
          return {
            success: true,
            data,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'HISTORY_LOAD_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Delete history entry
    ipcMain.handle(
      IPC_CHANNELS.HISTORY_DELETE,
      async (event: IpcMainInvokeEvent, payload: HistoryDeletePayload): Promise<IpcResponse> => {
        try {
          const deleted = await history.deleteEntry(payload.entryId);
          return {
            success: deleted,
            error: deleted ? undefined : {
              code: 'HISTORY_NOT_FOUND',
              message: `History entry ${payload.entryId} not found`,
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'HISTORY_DELETE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Restore conversation as new instance
    ipcMain.handle(
      IPC_CHANNELS.HISTORY_RESTORE,
      async (event: IpcMainInvokeEvent, payload: HistoryRestorePayload): Promise<IpcResponse> => {
        try {
          const data = await history.loadConversation(payload.entryId);
          if (!data) {
            return {
              success: false,
              error: {
                code: 'HISTORY_NOT_FOUND',
                message: `History entry ${payload.entryId} not found`,
                timestamp: Date.now(),
              },
            };
          }

          // Create a new instance that resumes the previous session
          // This allows Claude to have full context of the previous conversation
          const instance = await this.instanceManager.createInstance({
            workingDirectory: payload.workingDirectory || data.entry.workingDirectory,
            displayName: `${data.entry.displayName} (restored)`,
            sessionId: data.entry.sessionId,  // Use the original session ID
            resume: true,  // Resume the session to restore Claude's context
            initialOutputBuffer: data.messages,  // Pre-populate output buffer for display
          });

          return {
            success: true,
            data: {
              instanceId: instance.id,
              restoredMessages: data.messages,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'HISTORY_RESTORE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear all history
    ipcMain.handle(
      IPC_CHANNELS.HISTORY_CLEAR,
      async (): Promise<IpcResponse> => {
        try {
          await history.clearAll();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'HISTORY_CLEAR_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Serialize instance for IPC response
   */
  private serializeInstance(instance: any): Record<string, unknown> {
    return {
      ...instance,
      communicationTokens: instance.communicationTokens instanceof Map
        ? Object.fromEntries(instance.communicationTokens)
        : instance.communicationTokens,
    };
  }
}
