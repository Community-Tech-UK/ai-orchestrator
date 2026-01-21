/**
 * IPC Main Handler - Handles IPC communication from renderer
 */

import { ipcMain, IpcMainInvokeEvent, dialog, clipboard, shell } from 'electron';
import { InstanceManager } from '../instance/instance-manager';
import { WindowManager } from '../window-manager';
import { getSettingsManager } from '../settings/settings-manager';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { detectAvailableClis, isCliAvailable, CliType } from '../cli/cli-detector';
import type {
  InstanceCreatePayload,
  InstanceSendInputPayload,
  InstanceTerminatePayload,
  InstanceInterruptPayload,
  InstanceRestartPayload,
  InstanceRenamePayload,
  SettingsSetPayload,
  SettingsUpdatePayload,
  SettingsResetOnePayload,
  HistoryListPayload,
  HistoryLoadPayload,
  HistoryDeletePayload,
  HistoryRestorePayload,
  ProviderStatusPayload,
  ProviderUpdateConfigPayload,
  SessionForkPayload,
  SessionExportPayload,
  SessionImportPayload,
  SessionCopyToClipboardPayload,
  SessionSaveToFilePayload,
  SessionRevealFilePayload,
  CommandExecutePayload,
  CommandCreatePayload,
  CommandUpdatePayload,
  CommandDeletePayload,
  ConfigResolvePayload,
  ConfigGetProjectPayload,
  ConfigSaveProjectPayload,
  ConfigCreateProjectPayload,
  ConfigFindProjectPayload,
  PlanModeEnterPayload,
  PlanModeExitPayload,
  PlanModeApprovePayload,
  PlanModeUpdatePayload,
  PlanModeGetStatePayload,
  VcsIsRepoPayload,
  VcsGetStatusPayload,
  VcsGetBranchesPayload,
  VcsGetCommitsPayload,
  VcsGetDiffPayload,
  VcsGetFileHistoryPayload,
  VcsGetFileAtCommitPayload,
  VcsGetBlamePayload,
  SnapshotTakePayload,
  SnapshotStartSessionPayload,
  SnapshotEndSessionPayload,
  SnapshotGetForInstancePayload,
  SnapshotGetForFilePayload,
  SnapshotGetSessionsPayload,
  SnapshotGetContentPayload,
  SnapshotRevertFilePayload,
  SnapshotRevertSessionPayload,
  SnapshotGetDiffPayload,
  SnapshotDeletePayload,
  SnapshotCleanupPayload,
  TodoGetListPayload,
  TodoCreatePayload,
  TodoUpdatePayload,
  TodoDeletePayload,
  TodoWriteAllPayload,
  TodoClearPayload,
  TodoGetCurrentPayload,
  McpServerPayload,
  McpAddServerPayload,
  McpCallToolPayload,
  McpReadResourcePayload,
  McpGetPromptPayload,
  LspPositionPayload,
  LspFindReferencesPayload,
  LspFilePayload,
  LspWorkspaceSymbolPayload,
  MultiEditPayload,
  TaskGetStatusPayload,
  TaskGetHistoryPayload,
  TaskGetByParentPayload,
  TaskGetByChildPayload,
  TaskCancelPayload,
  SecurityDetectSecretsPayload,
  SecurityRedactContentPayload,
  SecurityCheckFilePayload,
  SecurityGetAuditLogPayload,
  SecurityCheckEnvVarPayload,
  SecurityUpdateEnvFilterConfigPayload,
  IpcResponse,
} from '../../shared/types/ipc.types';
import type { ExportedSession } from '../../shared/types/instance.types';
import { getCommandManager } from '../commands/command-manager';
import type { AppSettings } from '../../shared/types/settings.types';
import type { ProviderType } from '../../shared/types/provider.types';
import { getHistoryManager } from '../history';
import { getProviderRegistry } from '../providers';
import {
  resolveConfig,
  loadProjectConfig,
  saveProjectConfig,
  createProjectConfig,
  findProjectConfigPath,
} from '../settings/config-resolver';
import type { ProjectConfig } from '../../shared/types/settings.types';
import { createVcsManager, isGitAvailable } from '../vcs/vcs-manager';
import { getSnapshotManager } from '../snapshots/snapshot-manager';
import { getTodoManager } from '../todo/todo-manager';
import { getMcpManager } from '../mcp/mcp-manager';
import { MCP_SERVER_PRESETS } from '../../shared/types/mcp.types';
import { getLspManager } from '../lsp/lsp-manager';
import { getMultiEditManager } from '../multiedit/multiedit-manager';
import { getBashValidator } from '../security/bash-validator';
import { getTaskManager } from '../orchestration/task-manager';
import { registerOrchestrationHandlers } from './orchestration-ipc-handler';
import { registerVerificationHandlers } from './verification-ipc-handler';
import { registerCliVerificationHandlers } from './cli-verification-ipc-handler';
import { registerLearningHandlers } from './learning-ipc-handler';
import { registerMemoryHandlers } from './memory-ipc-handler';
import { registerSpecialistHandlers } from './specialist-ipc-handler';
import { registerTrainingHandlers } from './training-ipc-handler';
import { registerLLMHandlers } from './llm-ipc-handler';
import { RLMContextManager } from '../rlm/context-manager';
import {
  detectSecretsInContent,
  detectSecretsInEnvContent,
  isSecretFile,
  getFileSensitivity,
} from '../security/secret-detector';
import {
  redactEnvContent,
  redactAllSecrets,
  getSecretAuditLog,
} from '../security/secret-redaction';
import {
  getSafeEnv,
  shouldAllowEnvVar,
  DEFAULT_ENV_FILTER_CONFIG,
  type EnvFilterConfig,
} from '../security/env-filter';
import { getCostTracker } from '../cost/cost-tracker';
import { getSessionArchiveManager } from '../session/session-archive';
import { getRemoteConfigManager } from '../config/remote-config';
import { getExternalEditorManager } from '../editor/external-editor';
import { getFileWatcherManager } from '../watcher/file-watcher';
import { getLogManager } from '../logging/logger';
import { getDebugCommandsManager } from '../debug/debug-commands';
import { getUsageStatsManager } from '../stats/usage-stats';
import { getSemanticSearchManager } from '../search/semantic-search';
import { getProviderPluginsManager } from '../providers/provider-plugins';
import type {
  CostRecordUsagePayload,
  CostGetSummaryPayload,
  CostGetSessionCostPayload,
  CostSetBudgetPayload,
  CostGetEntriesPayload,
  ArchiveSessionPayload,
  ArchiveRestorePayload,
  ArchiveDeletePayload,
  ArchiveListPayload,
  ArchiveGetMetaPayload,
  ArchiveUpdateTagsPayload,
  ArchiveCleanupPayload,
  RemoteConfigFetchUrlPayload,
  RemoteConfigFetchWellKnownPayload,
  RemoteConfigFetchGitHubPayload,
  RemoteConfigDiscoverGitPayload,
  RemoteConfigInvalidatePayload,
  EditorOpenFilePayload,
  EditorOpenFileAtLinePayload,
  EditorOpenDirectoryPayload,
  EditorSetPreferredPayload,
  WatcherStartPayload,
  WatcherStopPayload,
  WatcherGetChangesPayload,
  WatcherClearBufferPayload,
  LogGetRecentPayload,
  LogSetLevelPayload,
  LogSetSubsystemLevelPayload,
  LogExportPayload,
  DebugAgentPayload,
  DebugConfigPayload,
  DebugFilePayload,
  DebugAllPayload,
  StatsGetPayload,
  StatsGetSessionPayload,
  StatsRecordSessionStartPayload,
  StatsRecordSessionEndPayload,
  StatsRecordMessagePayload,
  StatsRecordToolUsagePayload,
  StatsExportPayload,
  SearchSemanticPayload,
  SearchBuildIndexPayload,
  SearchConfigureExaPayload,
  PluginsLoadPayload,
  PluginsUnloadPayload,
  PluginsGetPayload,
  PluginsGetMetaPayload,
  PluginsInstallPayload,
  PluginsUninstallPayload,
  PluginsCreateTemplatePayload,
} from '../../shared/types/ipc.types';

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

    // Memory stats handlers (basic memory tracking)
    this.registerMemoryStatsHandlers();

    // History handlers
    this.registerHistoryHandlers();

    // Provider handlers
    this.registerProviderHandlers();

    // Session handlers (fork, export, import)
    this.registerSessionHandlers();

    // Command handlers
    this.registerCommandHandlers();

    // Config handlers (hierarchical configuration)
    this.registerConfigHandlers();

    // Plan mode handlers
    this.registerPlanModeHandlers();

    // VCS handlers (Git integration)
    this.registerVcsHandlers();

    // Snapshot handlers (File revert)
    this.registerSnapshotHandlers();

    // TODO handlers
    this.registerTodoHandlers();

    // MCP handlers
    this.registerMcpHandlers();

    // LSP handlers
    this.registerLspHandlers();

    // Multi-Edit handlers
    this.registerMultiEditHandlers();

    // Bash validation handlers
    this.registerBashHandlers();

    // Task management handlers (subagent spawning)
    this.registerTaskHandlers();

    // Security handlers (secret detection & env filtering)
    this.registerSecurityHandlers();

    // Cost tracking handlers (5.3)
    this.registerCostHandlers();

    // Session archive handlers (1.3)
    this.registerArchiveHandlers();

    // Remote config handlers (6.2)
    this.registerRemoteConfigHandlers();

    // External editor handlers (9.2)
    this.registerEditorHandlers();

    // File watcher handlers (10.1)
    this.registerWatcherHandlers();

    // Logging handlers (13.1)
    this.registerLoggingHandlers();

    // Debug command handlers (13.2)
    this.registerDebugHandlers();

    // Usage stats handlers (14.1)
    this.registerStatsHandlers();

    // Semantic search handlers (4.7)
    this.registerSearchHandlers();

    // Provider plugin handlers (12.2)
    this.registerPluginHandlers();

    // Orchestration handlers (Phase 6: Workflows, Hooks, Skills)
    registerOrchestrationHandlers();

    // Verification handlers (Worktree, Verification, Supervision)
    registerVerificationHandlers();

    // CLI Verification handlers (Multi-CLI detection and verification)
    // Pass WindowManager so handlers can lazily get the window when it's available
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

    // Set up memory event forwarding to renderer
    this.setupMemoryEventForwarding();
    this.setupRlmEventForwarding();

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
          // Use default working directory from settings if not provided or is just '.'
          let workingDirectory = payload.workingDirectory;
          if (!workingDirectory || workingDirectory === '.') {
            const settings = getSettingsManager();
            const defaultDir = settings.get('defaultWorkingDirectory');
            if (defaultDir) {
              workingDirectory = defaultDir;
            } else {
              workingDirectory = process.cwd();
            }
          }

          const instance = await this.instanceManager.createInstance({
            workingDirectory,
            sessionId: payload.sessionId,
            parentId: payload.parentInstanceId,
            displayName: payload.displayName,
            initialPrompt: payload.initialPrompt,
            attachments: payload.attachments,
            yoloMode: payload.yoloMode,
            agentId: payload.agentId,
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

    // Create instance with initial message
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_CREATE_WITH_MESSAGE,
      async (event: IpcMainInvokeEvent, payload: {
        workingDirectory: string;
        message: string;
        attachments?: any[];
      }): Promise<IpcResponse> => {
        try {
          // Use default working directory from settings if not provided or is just '.'
          let workingDirectory = payload.workingDirectory;
          if (!workingDirectory || workingDirectory === '.') {
            const settings = getSettingsManager();
            const defaultDir = settings.get('defaultWorkingDirectory');
            if (defaultDir) {
              workingDirectory = defaultDir;
            } else {
              workingDirectory = process.cwd();
            }
          }

          const instance = await this.instanceManager.createInstance({
            workingDirectory,
            initialPrompt: payload.message,
            attachments: payload.attachments,
          });

          return {
            success: true,
            data: this.serializeInstance(instance),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CREATE_WITH_MESSAGE_FAILED',
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

    // Interrupt instance (Ctrl+C equivalent)
    ipcMain.handle(
      IPC_CHANNELS.INSTANCE_INTERRUPT,
      async (event: IpcMainInvokeEvent, payload: InstanceInterruptPayload): Promise<IpcResponse> => {
        try {
          const success = this.instanceManager.interruptInstance(payload.instanceId);

          return {
            success,
            data: { interrupted: success },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'INTERRUPT_FAILED',
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

    // Note: CLI detection handlers (cli:detect-all, cli:detect-one, cli:test-connection)
    // are registered in cli-verification-ipc-handler.ts with more complete implementation

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

    // Open file selection dialog
    ipcMain.handle(
      IPC_CHANNELS.DIALOG_SELECT_FILES,
      async (
        _event,
        options?: { multiple?: boolean; filters?: { name: string; extensions: string[] }[] }
      ): Promise<IpcResponse> => {
        try {
          const properties: ('openFile' | 'multiSelections')[] = ['openFile'];
          if (options?.multiple) {
            properties.push('multiSelections');
          }

          const result = await dialog.showOpenDialog({
            properties,
            title: options?.multiple ? 'Select Files' : 'Select File',
            buttonLabel: 'Select',
            filters: options?.filters || [
              { name: 'All Files', extensions: ['*'] },
              { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] },
              { name: 'Documents', extensions: ['pdf', 'txt', 'md', 'json', 'csv'] },
              { name: 'Code', extensions: ['ts', 'js', 'py', 'go', 'rs', 'java', 'cpp', 'c', 'h'] },
            ],
          });

          if (result.canceled || result.filePaths.length === 0) {
            return {
              success: true,
              data: null, // User cancelled
            };
          }

          return {
            success: true,
            data: result.filePaths,
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
      }
    );

    // Read directory contents
    ipcMain.handle(
      IPC_CHANNELS.FILE_READ_DIR,
      async (
        _event: IpcMainInvokeEvent,
        payload: { path: string; includeHidden?: boolean }
      ): Promise<IpcResponse> => {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');

          const entries = await fs.readdir(payload.path, { withFileTypes: true });
          const results = await Promise.all(
            entries
              .filter((entry) => {
                // Filter hidden files unless explicitly included
                if (!payload.includeHidden && entry.name.startsWith('.')) {
                  return false;
                }
                return true;
              })
              .map(async (entry) => {
                const fullPath = path.join(payload.path, entry.name);
                let stats;
                try {
                  stats = await fs.stat(fullPath);
                } catch {
                  // Skip files we can't stat
                  return null;
                }

                return {
                  name: entry.name,
                  path: fullPath,
                  isDirectory: entry.isDirectory(),
                  isSymlink: entry.isSymbolicLink(),
                  size: stats.size,
                  modifiedAt: stats.mtimeMs,
                  extension: entry.isFile() ? path.extname(entry.name).slice(1) : undefined,
                };
              })
          );

          // Filter out nulls and sort: directories first, then alphabetically
          const filtered = results.filter((r) => r !== null);
          filtered.sort((a, b) => {
            if (a!.isDirectory && !b!.isDirectory) return -1;
            if (!a!.isDirectory && b!.isDirectory) return 1;
            return a!.name.localeCompare(b!.name);
          });

          return {
            success: true,
            data: filtered,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'FILE_READ_DIR_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get file stats
    ipcMain.handle(
      IPC_CHANNELS.FILE_GET_STATS,
      async (
        _event: IpcMainInvokeEvent,
        payload: { path: string }
      ): Promise<IpcResponse> => {
        try {
          const fs = await import('fs/promises');
          const path = await import('path');

          const stats = await fs.stat(payload.path);

          return {
            success: true,
            data: {
              name: path.basename(payload.path),
              path: payload.path,
              isDirectory: stats.isDirectory(),
              isSymlink: stats.isSymbolicLink(),
              size: stats.size,
              modifiedAt: stats.mtimeMs,
              createdAt: stats.birthtimeMs,
              extension: stats.isFile() ? path.extname(payload.path).slice(1) : undefined,
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'FILE_GET_STATS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
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
   * Register basic memory stats handlers
   */
  private registerMemoryStatsHandlers(): void {
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
   * Set up RLM event forwarding to renderer
   */
  private setupRlmEventForwarding(): void {
    const rlm = RLMContextManager.getInstance();

    rlm.on('store:created', (store) => {
      this.windowManager.getMainWindow()?.webContents.send('rlm:store-updated', {
        storeId: store.id,
        store,
      });
    });

    rlm.on('section:added', ({ store, section }) => {
      this.windowManager.getMainWindow()?.webContents.send('rlm:section-added', {
        storeId: store.id,
        section,
      });
      this.windowManager.getMainWindow()?.webContents.send('rlm:store-updated', {
        storeId: store.id,
        store,
      });
    });

    rlm.on('section:removed', ({ store, section }) => {
      this.windowManager.getMainWindow()?.webContents.send('rlm:section-removed', {
        storeId: store.id,
        sectionId: section.id,
      });
      this.windowManager.getMainWindow()?.webContents.send('rlm:store-updated', {
        storeId: store.id,
        store,
      });
    });

    rlm.on('query:executed', ({ session, queryResult }) => {
      this.windowManager.getMainWindow()?.webContents.send('rlm:query-complete', {
        sessionId: session.id,
        queryResult,
      });
    });

    rlm.on('summary:created', ({ storeId, section }) => {
      this.windowManager.getMainWindow()?.webContents.send('rlm:section-added', {
        storeId,
        section,
      });
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
   * Register provider-related handlers
   */
  private registerProviderHandlers(): void {
    const registry = getProviderRegistry();

    // List all provider configurations
    ipcMain.handle(
      IPC_CHANNELS.PROVIDER_LIST,
      async (): Promise<IpcResponse> => {
        try {
          const configs = registry.getAllConfigs();
          return {
            success: true,
            data: configs,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PROVIDER_LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get status of a specific provider
    ipcMain.handle(
      IPC_CHANNELS.PROVIDER_STATUS,
      async (event: IpcMainInvokeEvent, payload: ProviderStatusPayload): Promise<IpcResponse> => {
        try {
          const status = await registry.checkProviderStatus(
            payload.providerType as ProviderType,
            payload.forceRefresh
          );
          return {
            success: true,
            data: status,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PROVIDER_STATUS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get status of all providers
    ipcMain.handle(
      IPC_CHANNELS.PROVIDER_STATUS_ALL,
      async (): Promise<IpcResponse> => {
        try {
          const statuses = await registry.checkAllProviderStatus();
          // Convert Map to object for IPC
          const statusObj: Record<string, unknown> = {};
          for (const [type, status] of statuses) {
            statusObj[type] = status;
          }
          return {
            success: true,
            data: statusObj,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PROVIDER_STATUS_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update provider configuration
    ipcMain.handle(
      IPC_CHANNELS.PROVIDER_UPDATE_CONFIG,
      async (event: IpcMainInvokeEvent, payload: ProviderUpdateConfigPayload): Promise<IpcResponse> => {
        try {
          registry.updateConfig(payload.providerType as ProviderType, payload.config);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PROVIDER_UPDATE_CONFIG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register session-related handlers (fork, export, import)
   */
  private registerSessionHandlers(): void {
    // Fork session
    ipcMain.handle(
      IPC_CHANNELS.SESSION_FORK,
      async (event: IpcMainInvokeEvent, payload: SessionForkPayload): Promise<IpcResponse> => {
        try {
          const forkedInstance = await this.instanceManager.forkInstance({
            instanceId: payload.instanceId,
            atMessageIndex: payload.atMessageIndex,
            displayName: payload.displayName,
          });
          return {
            success: true,
            data: this.serializeInstance(forkedInstance),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SESSION_FORK_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Export session
    ipcMain.handle(
      IPC_CHANNELS.SESSION_EXPORT,
      async (event: IpcMainInvokeEvent, payload: SessionExportPayload): Promise<IpcResponse> => {
        try {
          if (payload.format === 'json') {
            const exported = this.instanceManager.exportSession(payload.instanceId);
            return {
              success: true,
              data: exported,
            };
          } else {
            const markdown = this.instanceManager.exportSessionMarkdown(payload.instanceId);
            return {
              success: true,
              data: markdown,
            };
          }
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SESSION_EXPORT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Import session
    ipcMain.handle(
      IPC_CHANNELS.SESSION_IMPORT,
      async (event: IpcMainInvokeEvent, payload: SessionImportPayload): Promise<IpcResponse> => {
        try {
          // Read and parse the file
          const fs = require('fs').promises;
          const content = await fs.readFile(payload.filePath, 'utf-8');
          const session: ExportedSession = JSON.parse(content);

          // Validate version
          if (!session.version || !session.messages) {
            return {
              success: false,
              error: {
                code: 'INVALID_SESSION_FORMAT',
                message: 'Invalid session file format',
                timestamp: Date.now(),
              },
            };
          }

          const instance = await this.instanceManager.importSession(
            session,
            payload.workingDirectory
          );

          return {
            success: true,
            data: this.serializeInstance(instance),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SESSION_IMPORT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Copy session to clipboard
    ipcMain.handle(
      IPC_CHANNELS.SESSION_COPY_TO_CLIPBOARD,
      async (event: IpcMainInvokeEvent, payload: SessionCopyToClipboardPayload): Promise<IpcResponse> => {
        try {
          let content: string;
          if (payload.format === 'json') {
            const exported = this.instanceManager.exportSession(payload.instanceId);
            content = JSON.stringify(exported, null, 2);
          } else {
            content = this.instanceManager.exportSessionMarkdown(payload.instanceId);
          }

          clipboard.writeText(content);
          return { success: true, data: { copied: true, format: payload.format } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SESSION_COPY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Save session to file
    ipcMain.handle(
      IPC_CHANNELS.SESSION_SAVE_TO_FILE,
      async (event: IpcMainInvokeEvent, payload: SessionSaveToFilePayload): Promise<IpcResponse> => {
        try {
          let filePath = payload.filePath;

          // Show save dialog if no path provided
          if (!filePath) {
            const instance = this.instanceManager.getInstance(payload.instanceId);
            const defaultName = instance?.displayName?.replace(/[^a-z0-9]/gi, '_') || 'session';
            const extension = payload.format === 'json' ? 'json' : 'md';

            const result = await dialog.showSaveDialog({
              title: 'Save Session',
              defaultPath: `${defaultName}.${extension}`,
              filters: [
                payload.format === 'json'
                  ? { name: 'JSON', extensions: ['json'] }
                  : { name: 'Markdown', extensions: ['md'] },
              ],
            });

            if (result.canceled || !result.filePath) {
              return { success: false, error: { code: 'SAVE_CANCELLED', message: 'Save cancelled', timestamp: Date.now() } };
            }
            filePath = result.filePath;
          }

          // Export and write
          let content: string;
          if (payload.format === 'json') {
            const exported = this.instanceManager.exportSession(payload.instanceId);
            content = JSON.stringify(exported, null, 2);
          } else {
            content = this.instanceManager.exportSessionMarkdown(payload.instanceId);
          }

          const fs = require('fs').promises;
          await fs.writeFile(filePath, content, 'utf-8');

          return { success: true, data: { filePath, format: payload.format } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SESSION_SAVE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Reveal file in system file manager
    ipcMain.handle(
      IPC_CHANNELS.SESSION_REVEAL_FILE,
      async (event: IpcMainInvokeEvent, payload: SessionRevealFilePayload): Promise<IpcResponse> => {
        try {
          shell.showItemInFolder(payload.filePath);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REVEAL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register command-related handlers
   */
  private registerCommandHandlers(): void {
    const commands = getCommandManager();

    // List all commands
    ipcMain.handle(
      IPC_CHANNELS.COMMAND_LIST,
      async (): Promise<IpcResponse> => {
        try {
          const allCommands = commands.getAllCommands();
          return {
            success: true,
            data: allCommands,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COMMAND_LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Execute command
    ipcMain.handle(
      IPC_CHANNELS.COMMAND_EXECUTE,
      async (event: IpcMainInvokeEvent, payload: CommandExecutePayload): Promise<IpcResponse> => {
        try {
          const resolved = commands.executeCommand(payload.commandId, payload.args || []);
          if (!resolved) {
            return {
              success: false,
              error: {
                code: 'COMMAND_NOT_FOUND',
                message: `Command ${payload.commandId} not found`,
                timestamp: Date.now(),
              },
            };
          }

          // Send the resolved prompt to the instance
          await this.instanceManager.sendInput(payload.instanceId, resolved.resolvedPrompt);

          return {
            success: true,
            data: resolved,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COMMAND_EXECUTE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Create custom command
    ipcMain.handle(
      IPC_CHANNELS.COMMAND_CREATE,
      async (event: IpcMainInvokeEvent, payload: CommandCreatePayload): Promise<IpcResponse> => {
        try {
          const command = commands.createCommand(payload);
          return {
            success: true,
            data: command,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COMMAND_CREATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update custom command
    ipcMain.handle(
      IPC_CHANNELS.COMMAND_UPDATE,
      async (event: IpcMainInvokeEvent, payload: CommandUpdatePayload): Promise<IpcResponse> => {
        try {
          const updated = commands.updateCommand(payload.commandId, payload.updates);
          if (!updated) {
            return {
              success: false,
              error: {
                code: 'COMMAND_NOT_FOUND',
                message: `Command ${payload.commandId} not found or is built-in`,
                timestamp: Date.now(),
              },
            };
          }
          return {
            success: true,
            data: updated,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COMMAND_UPDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Delete custom command
    ipcMain.handle(
      IPC_CHANNELS.COMMAND_DELETE,
      async (event: IpcMainInvokeEvent, payload: CommandDeletePayload): Promise<IpcResponse> => {
        try {
          const deleted = commands.deleteCommand(payload.commandId);
          return {
            success: deleted,
            error: deleted ? undefined : {
              code: 'COMMAND_NOT_FOUND',
              message: `Command ${payload.commandId} not found or is built-in`,
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COMMAND_DELETE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register plan mode handlers
   */
  private registerPlanModeHandlers(): void {
    // Enter plan mode
    ipcMain.handle(
      IPC_CHANNELS.PLAN_MODE_ENTER,
      async (event: IpcMainInvokeEvent, payload: PlanModeEnterPayload): Promise<IpcResponse> => {
        try {
          const instance = this.instanceManager.enterPlanMode(payload.instanceId);
          return {
            success: true,
            data: { planMode: instance.planMode },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLAN_MODE_ENTER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Exit plan mode
    ipcMain.handle(
      IPC_CHANNELS.PLAN_MODE_EXIT,
      async (event: IpcMainInvokeEvent, payload: PlanModeExitPayload): Promise<IpcResponse> => {
        try {
          const instance = this.instanceManager.exitPlanMode(payload.instanceId, payload.force);
          return {
            success: true,
            data: { planMode: instance.planMode },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLAN_MODE_EXIT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Approve plan
    ipcMain.handle(
      IPC_CHANNELS.PLAN_MODE_APPROVE,
      async (event: IpcMainInvokeEvent, payload: PlanModeApprovePayload): Promise<IpcResponse> => {
        try {
          const instance = this.instanceManager.approvePlan(payload.instanceId, payload.planContent);
          return {
            success: true,
            data: { planMode: instance.planMode },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLAN_MODE_APPROVE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update plan content
    ipcMain.handle(
      IPC_CHANNELS.PLAN_MODE_UPDATE,
      async (event: IpcMainInvokeEvent, payload: PlanModeUpdatePayload): Promise<IpcResponse> => {
        try {
          const instance = this.instanceManager.updatePlanContent(payload.instanceId, payload.planContent);
          return {
            success: true,
            data: { planMode: instance.planMode },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLAN_MODE_UPDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get plan mode state
    ipcMain.handle(
      IPC_CHANNELS.PLAN_MODE_GET_STATE,
      async (event: IpcMainInvokeEvent, payload: PlanModeGetStatePayload): Promise<IpcResponse> => {
        try {
          const state = this.instanceManager.getPlanModeState(payload.instanceId);
          return {
            success: true,
            data: state,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLAN_MODE_GET_STATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register config-related handlers (hierarchical configuration)
   */
  private registerConfigHandlers(): void {
    // Resolve configuration for a working directory
    ipcMain.handle(
      IPC_CHANNELS.CONFIG_RESOLVE,
      async (event: IpcMainInvokeEvent, payload: ConfigResolvePayload): Promise<IpcResponse> => {
        try {
          const resolved = resolveConfig(payload.workingDirectory);
          return {
            success: true,
            data: resolved,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CONFIG_RESOLVE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get project config from a specific path
    ipcMain.handle(
      IPC_CHANNELS.CONFIG_GET_PROJECT,
      async (event: IpcMainInvokeEvent, payload: ConfigGetProjectPayload): Promise<IpcResponse> => {
        try {
          const config = loadProjectConfig(payload.configPath);
          if (!config) {
            return {
              success: false,
              error: {
                code: 'CONFIG_NOT_FOUND',
                message: `Project config not found at ${payload.configPath}`,
                timestamp: Date.now(),
              },
            };
          }
          return {
            success: true,
            data: config,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CONFIG_GET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Save project config
    ipcMain.handle(
      IPC_CHANNELS.CONFIG_SAVE_PROJECT,
      async (event: IpcMainInvokeEvent, payload: ConfigSaveProjectPayload): Promise<IpcResponse> => {
        try {
          const saved = saveProjectConfig(payload.configPath, payload.config as ProjectConfig);
          return {
            success: saved,
            error: saved ? undefined : {
              code: 'CONFIG_SAVE_FAILED',
              message: `Failed to save project config to ${payload.configPath}`,
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CONFIG_SAVE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Create new project config
    ipcMain.handle(
      IPC_CHANNELS.CONFIG_CREATE_PROJECT,
      async (event: IpcMainInvokeEvent, payload: ConfigCreateProjectPayload): Promise<IpcResponse> => {
        try {
          const configPath = createProjectConfig(
            payload.projectDir,
            payload.config as Partial<ProjectConfig>
          );
          return {
            success: true,
            data: { configPath },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CONFIG_CREATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Find project config path
    ipcMain.handle(
      IPC_CHANNELS.CONFIG_FIND_PROJECT,
      async (event: IpcMainInvokeEvent, payload: ConfigFindProjectPayload): Promise<IpcResponse> => {
        try {
          const configPath = findProjectConfigPath(payload.startDir);
          return {
            success: true,
            data: { configPath },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'CONFIG_FIND_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register VCS (Git) handlers
   */
  private registerVcsHandlers(): void {
    // Check if working directory is a git repository
    ipcMain.handle(
      IPC_CHANNELS.VCS_IS_REPO,
      async (event: IpcMainInvokeEvent, payload: VcsIsRepoPayload): Promise<IpcResponse> => {
        try {
          if (!isGitAvailable()) {
            return {
              success: true,
              data: { isRepo: false, gitAvailable: false },
            };
          }
          const vcs = createVcsManager(payload.workingDirectory);
          const isRepo = vcs.isGitRepository();
          const gitRoot = isRepo ? vcs.findGitRoot() : null;
          return {
            success: true,
            data: { isRepo, gitRoot, gitAvailable: true },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_IS_REPO_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get git status
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_STATUS,
      async (event: IpcMainInvokeEvent, payload: VcsGetStatusPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const status = vcs.getStatus();
          return {
            success: true,
            data: status,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_STATUS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get branches
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_BRANCHES,
      async (event: IpcMainInvokeEvent, payload: VcsGetBranchesPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const branches = vcs.getBranches();
          const currentBranch = vcs.getCurrentBranch();
          return {
            success: true,
            data: { branches, currentBranch },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_BRANCHES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get recent commits
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_COMMITS,
      async (event: IpcMainInvokeEvent, payload: VcsGetCommitsPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const commits = vcs.getRecentCommits(payload.limit || 50);
          return {
            success: true,
            data: commits,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_COMMITS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get diff
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_DIFF,
      async (event: IpcMainInvokeEvent, payload: VcsGetDiffPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          let diff;

          if (payload.filePath) {
            diff = vcs.getFileDiff(payload.filePath, payload.type === 'staged');
          } else if (payload.type === 'staged') {
            diff = vcs.getStagedDiff();
          } else if (payload.type === 'unstaged') {
            diff = vcs.getUnstagedDiff();
          } else if (payload.type === 'between' && payload.fromRef && payload.toRef) {
            diff = vcs.getDiffBetween(payload.fromRef, payload.toRef);
          } else {
            diff = vcs.getUnstagedDiff();
          }

          const stats = vcs.getDiffStats(payload.type === 'staged');

          return {
            success: true,
            data: { diff, stats },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_DIFF_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get file history
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_FILE_HISTORY,
      async (event: IpcMainInvokeEvent, payload: VcsGetFileHistoryPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const history = vcs.getFileHistory(payload.filePath, payload.limit || 20);
          const isTracked = vcs.isFileTracked(payload.filePath);
          return {
            success: true,
            data: { history, isTracked },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_FILE_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get file at specific commit
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_FILE_AT_COMMIT,
      async (event: IpcMainInvokeEvent, payload: VcsGetFileAtCommitPayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const content = vcs.getFileAtCommit(payload.filePath, payload.commitHash);
          return {
            success: true,
            data: { content },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_FILE_AT_COMMIT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get blame for file
    ipcMain.handle(
      IPC_CHANNELS.VCS_GET_BLAME,
      async (event: IpcMainInvokeEvent, payload: VcsGetBlamePayload): Promise<IpcResponse> => {
        try {
          const vcs = createVcsManager(payload.workingDirectory);
          const blame = vcs.getBlame(payload.filePath);
          return {
            success: true,
            data: { blame },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'VCS_GET_BLAME_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register snapshot handlers (file revert)
   */
  private registerSnapshotHandlers(): void {
    const snapshots = getSnapshotManager();

    // Take a snapshot
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_TAKE,
      async (event: IpcMainInvokeEvent, payload: SnapshotTakePayload): Promise<IpcResponse> => {
        try {
          const snapshotId = snapshots.takeSnapshot(
            payload.filePath,
            payload.instanceId,
            payload.sessionId,
            payload.action
          );
          return {
            success: true,
            data: { snapshotId },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_TAKE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Start a session
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_START_SESSION,
      async (event: IpcMainInvokeEvent, payload: SnapshotStartSessionPayload): Promise<IpcResponse> => {
        try {
          const sessionId = snapshots.startSession(payload.instanceId, payload.description);
          return {
            success: true,
            data: { sessionId },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_START_SESSION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // End a session
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_END_SESSION,
      async (event: IpcMainInvokeEvent, payload: SnapshotEndSessionPayload): Promise<IpcResponse> => {
        try {
          const session = snapshots.endSession(payload.sessionId);
          return {
            success: true,
            data: session,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_END_SESSION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get snapshots for instance
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_FOR_INSTANCE,
      async (event: IpcMainInvokeEvent, payload: SnapshotGetForInstancePayload): Promise<IpcResponse> => {
        try {
          const snapshotList = snapshots.getSnapshotsForInstance(payload.instanceId);
          return {
            success: true,
            data: snapshotList,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_FOR_INSTANCE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get snapshots for file
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_FOR_FILE,
      async (event: IpcMainInvokeEvent, payload: SnapshotGetForFilePayload): Promise<IpcResponse> => {
        try {
          const snapshotList = snapshots.getSnapshotsForFile(payload.filePath);
          return {
            success: true,
            data: snapshotList,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_FOR_FILE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get sessions for instance
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_SESSIONS,
      async (event: IpcMainInvokeEvent, payload: SnapshotGetSessionsPayload): Promise<IpcResponse> => {
        try {
          const sessions = snapshots.getSessionsForInstance(payload.instanceId);
          return {
            success: true,
            data: sessions,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_SESSIONS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get snapshot content
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_CONTENT,
      async (event: IpcMainInvokeEvent, payload: SnapshotGetContentPayload): Promise<IpcResponse> => {
        try {
          const content = snapshots.getSnapshotContent(payload.snapshotId);
          return {
            success: true,
            data: { content },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_CONTENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Revert a file
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_REVERT_FILE,
      async (event: IpcMainInvokeEvent, payload: SnapshotRevertFilePayload): Promise<IpcResponse> => {
        try {
          const result = snapshots.revertFile(payload.snapshotId);
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'SNAPSHOT_REVERT_FAILED',
              message: result.errors.map(e => e.error).join(', '),
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_REVERT_FILE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Revert a session
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_REVERT_SESSION,
      async (event: IpcMainInvokeEvent, payload: SnapshotRevertSessionPayload): Promise<IpcResponse> => {
        try {
          const result = snapshots.revertSession(payload.sessionId);
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'SNAPSHOT_REVERT_SESSION_FAILED',
              message: result.errors.map(e => e.error).join(', '),
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_REVERT_SESSION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get diff between snapshot and current
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_DIFF,
      async (event: IpcMainInvokeEvent, payload: SnapshotGetDiffPayload): Promise<IpcResponse> => {
        try {
          const diff = snapshots.getSnapshotDiff(payload.snapshotId);
          return {
            success: true,
            data: diff,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_DIFF_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Delete a snapshot
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_DELETE,
      async (event: IpcMainInvokeEvent, payload: SnapshotDeletePayload): Promise<IpcResponse> => {
        try {
          const deleted = snapshots.deleteSnapshot(payload.snapshotId);
          return {
            success: deleted,
            error: deleted ? undefined : {
              code: 'SNAPSHOT_NOT_FOUND',
              message: `Snapshot ${payload.snapshotId} not found`,
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_DELETE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Cleanup old snapshots
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_CLEANUP,
      async (event: IpcMainInvokeEvent, payload: SnapshotCleanupPayload): Promise<IpcResponse> => {
        try {
          const deletedCount = snapshots.cleanupOldSnapshots(payload.maxAgeDays);
          return {
            success: true,
            data: { deletedCount },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_CLEANUP_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get stats
    ipcMain.handle(
      IPC_CHANNELS.SNAPSHOT_GET_STATS,
      async (): Promise<IpcResponse> => {
        try {
          const stats = snapshots.getStats();
          return {
            success: true,
            data: stats,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SNAPSHOT_GET_STATS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register TODO-related handlers
   */
  private registerTodoHandlers(): void {
    const todos = getTodoManager();

    // Set up event forwarding to renderer
    todos.on('todos:changed', (sessionId, list) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.TODO_LIST_CHANGED,
        { sessionId, list }
      );
    });

    // Get TODO list for a session
    ipcMain.handle(
      IPC_CHANNELS.TODO_GET_LIST,
      async (event: IpcMainInvokeEvent, payload: TodoGetListPayload): Promise<IpcResponse> => {
        try {
          const list = todos.getTodoList(payload.sessionId);
          return {
            success: true,
            data: list,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_GET_LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Create a TODO
    ipcMain.handle(
      IPC_CHANNELS.TODO_CREATE,
      async (event: IpcMainInvokeEvent, payload: TodoCreatePayload): Promise<IpcResponse> => {
        try {
          const item = todos.createTodo(payload.sessionId, {
            content: payload.content,
            activeForm: payload.activeForm,
            priority: payload.priority,
            parentId: payload.parentId,
          });
          return {
            success: true,
            data: item,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_CREATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update a TODO
    ipcMain.handle(
      IPC_CHANNELS.TODO_UPDATE,
      async (event: IpcMainInvokeEvent, payload: TodoUpdatePayload): Promise<IpcResponse> => {
        try {
          const item = todos.updateTodo(payload.sessionId, {
            id: payload.todoId,
            content: payload.content,
            activeForm: payload.activeForm,
            status: payload.status,
            priority: payload.priority,
          });
          if (!item) {
            return {
              success: false,
              error: {
                code: 'TODO_NOT_FOUND',
                message: `TODO ${payload.todoId} not found`,
                timestamp: Date.now(),
              },
            };
          }
          return {
            success: true,
            data: item,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_UPDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Delete a TODO
    ipcMain.handle(
      IPC_CHANNELS.TODO_DELETE,
      async (event: IpcMainInvokeEvent, payload: TodoDeletePayload): Promise<IpcResponse> => {
        try {
          const deleted = todos.deleteTodo(payload.sessionId, payload.todoId);
          return {
            success: deleted,
            error: deleted ? undefined : {
              code: 'TODO_NOT_FOUND',
              message: `TODO ${payload.todoId} not found`,
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_DELETE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Write all TODOs (replaces existing - matches Claude's TodoWrite format)
    ipcMain.handle(
      IPC_CHANNELS.TODO_WRITE_ALL,
      async (event: IpcMainInvokeEvent, payload: TodoWriteAllPayload): Promise<IpcResponse> => {
        try {
          const list = todos.writeTodos(payload.sessionId, payload.todos);
          return {
            success: true,
            data: list,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_WRITE_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear all TODOs for a session
    ipcMain.handle(
      IPC_CHANNELS.TODO_CLEAR,
      async (event: IpcMainInvokeEvent, payload: TodoClearPayload): Promise<IpcResponse> => {
        try {
          todos.clearTodos(payload.sessionId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_CLEAR_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get the current in-progress TODO
    ipcMain.handle(
      IPC_CHANNELS.TODO_GET_CURRENT,
      async (event: IpcMainInvokeEvent, payload: TodoGetCurrentPayload): Promise<IpcResponse> => {
        try {
          const current = todos.getCurrentTodo(payload.sessionId);
          return {
            success: true,
            data: current || null,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TODO_GET_CURRENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register MCP-related handlers
   */
  private registerMcpHandlers(): void {
    const mcp = getMcpManager();

    // Set up event forwarding to renderer
    mcp.on('server:connected', (serverId) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId, status: 'connected' }
      );
    });

    mcp.on('server:disconnected', (serverId) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId, status: 'disconnected' }
      );
    });

    mcp.on('server:error', (serverId, error) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED,
        { serverId, status: 'error', error }
      );
    });

    mcp.on('tools:updated', (tools) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_STATE_CHANGED,
        { type: 'tools' }
      );
    });

    mcp.on('resources:updated', (resources) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_STATE_CHANGED,
        { type: 'resources' }
      );
    });

    mcp.on('prompts:updated', (prompts) => {
      this.windowManager.getMainWindow()?.webContents.send(
        IPC_CHANNELS.MCP_STATE_CHANGED,
        { type: 'prompts' }
      );
    });

    // Get full MCP state
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_STATE,
      async (): Promise<IpcResponse> => {
        try {
          const state = mcp.getState();
          return {
            success: true,
            data: state,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_STATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get all servers
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_SERVERS,
      async (): Promise<IpcResponse> => {
        try {
          const servers = mcp.getServers();
          return {
            success: true,
            data: servers,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_SERVERS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Add a server
    ipcMain.handle(
      IPC_CHANNELS.MCP_ADD_SERVER,
      async (event: IpcMainInvokeEvent, payload: McpAddServerPayload): Promise<IpcResponse> => {
        try {
          mcp.addServer({
            id: payload.id,
            name: payload.name,
            description: payload.description,
            transport: payload.transport,
            command: payload.command,
            args: payload.args,
            env: payload.env,
            url: payload.url,
            autoConnect: payload.autoConnect,
          });
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_ADD_SERVER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Remove a server
    ipcMain.handle(
      IPC_CHANNELS.MCP_REMOVE_SERVER,
      async (event: IpcMainInvokeEvent, payload: McpServerPayload): Promise<IpcResponse> => {
        try {
          await mcp.removeServer(payload.serverId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_REMOVE_SERVER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Connect to a server
    ipcMain.handle(
      IPC_CHANNELS.MCP_CONNECT,
      async (event: IpcMainInvokeEvent, payload: McpServerPayload): Promise<IpcResponse> => {
        try {
          await mcp.connect(payload.serverId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_CONNECT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Disconnect from a server
    ipcMain.handle(
      IPC_CHANNELS.MCP_DISCONNECT,
      async (event: IpcMainInvokeEvent, payload: McpServerPayload): Promise<IpcResponse> => {
        try {
          await mcp.disconnect(payload.serverId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_DISCONNECT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Restart a server
    ipcMain.handle(
      IPC_CHANNELS.MCP_RESTART,
      async (event: IpcMainInvokeEvent, payload: McpServerPayload): Promise<IpcResponse> => {
        try {
          await mcp.restart(payload.serverId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_RESTART_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get tools
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_TOOLS,
      async (): Promise<IpcResponse> => {
        try {
          const tools = mcp.getTools();
          return {
            success: true,
            data: tools,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_TOOLS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get resources
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_RESOURCES,
      async (): Promise<IpcResponse> => {
        try {
          const resources = mcp.getResources();
          return {
            success: true,
            data: resources,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_RESOURCES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get prompts
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_PROMPTS,
      async (): Promise<IpcResponse> => {
        try {
          const prompts = mcp.getPrompts();
          return {
            success: true,
            data: prompts,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_PROMPTS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Call a tool
    ipcMain.handle(
      IPC_CHANNELS.MCP_CALL_TOOL,
      async (event: IpcMainInvokeEvent, payload: McpCallToolPayload): Promise<IpcResponse> => {
        try {
          const result = await mcp.callTool({
            serverId: payload.serverId,
            toolName: payload.toolName,
            arguments: payload.arguments,
          });
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'MCP_TOOL_CALL_ERROR',
              message: result.error || 'Unknown error',
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_CALL_TOOL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Read a resource
    ipcMain.handle(
      IPC_CHANNELS.MCP_READ_RESOURCE,
      async (event: IpcMainInvokeEvent, payload: McpReadResourcePayload): Promise<IpcResponse> => {
        try {
          const result = await mcp.readResource({
            serverId: payload.serverId,
            uri: payload.uri,
          });
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'MCP_RESOURCE_READ_ERROR',
              message: result.error || 'Unknown error',
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_READ_RESOURCE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get a prompt
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_PROMPT,
      async (event: IpcMainInvokeEvent, payload: McpGetPromptPayload): Promise<IpcResponse> => {
        try {
          const result = await mcp.getPrompt({
            serverId: payload.serverId,
            promptName: payload.promptName,
            arguments: payload.arguments,
          });
          return {
            success: result.success,
            data: result,
            error: result.success ? undefined : {
              code: 'MCP_PROMPT_GET_ERROR',
              message: result.error || 'Unknown error',
              timestamp: Date.now(),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MCP_GET_PROMPT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get server presets
    ipcMain.handle(
      IPC_CHANNELS.MCP_GET_PRESETS,
      async (): Promise<IpcResponse> => {
        return {
          success: true,
          data: MCP_SERVER_PRESETS,
        };
      }
    );
  }

  /**
   * Register LSP-related handlers
   */
  private registerLspHandlers(): void {
    const lsp = getLspManager();

    // Get available LSP servers
    ipcMain.handle(
      IPC_CHANNELS.LSP_GET_AVAILABLE_SERVERS,
      async (): Promise<IpcResponse> => {
        try {
          const servers = lsp.getAvailableServers();
          return {
            success: true,
            data: servers,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_GET_AVAILABLE_SERVERS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get LSP client status
    ipcMain.handle(
      IPC_CHANNELS.LSP_GET_STATUS,
      async (): Promise<IpcResponse> => {
        try {
          const status = lsp.getStatus();
          return {
            success: true,
            data: status,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_GET_STATUS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Go to definition
    ipcMain.handle(
      IPC_CHANNELS.LSP_GO_TO_DEFINITION,
      async (event: IpcMainInvokeEvent, payload: LspPositionPayload): Promise<IpcResponse> => {
        try {
          const locations = await lsp.goToDefinition(payload.filePath, payload.line, payload.character);
          return {
            success: true,
            data: locations,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_GO_TO_DEFINITION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Find references
    ipcMain.handle(
      IPC_CHANNELS.LSP_FIND_REFERENCES,
      async (event: IpcMainInvokeEvent, payload: LspFindReferencesPayload): Promise<IpcResponse> => {
        try {
          const locations = await lsp.findReferences(
            payload.filePath,
            payload.line,
            payload.character,
            payload.includeDeclaration ?? true
          );
          return {
            success: true,
            data: locations,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_FIND_REFERENCES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Hover
    ipcMain.handle(
      IPC_CHANNELS.LSP_HOVER,
      async (event: IpcMainInvokeEvent, payload: LspPositionPayload): Promise<IpcResponse> => {
        try {
          const hover = await lsp.hover(payload.filePath, payload.line, payload.character);
          return {
            success: true,
            data: hover,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_HOVER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Document symbols
    ipcMain.handle(
      IPC_CHANNELS.LSP_DOCUMENT_SYMBOLS,
      async (event: IpcMainInvokeEvent, payload: LspFilePayload): Promise<IpcResponse> => {
        try {
          const symbols = await lsp.getDocumentSymbols(payload.filePath);
          return {
            success: true,
            data: symbols,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_DOCUMENT_SYMBOLS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Workspace symbols
    ipcMain.handle(
      IPC_CHANNELS.LSP_WORKSPACE_SYMBOLS,
      async (event: IpcMainInvokeEvent, payload: LspWorkspaceSymbolPayload): Promise<IpcResponse> => {
        try {
          const symbols = await lsp.workspaceSymbol(payload.query, payload.rootPath);
          return {
            success: true,
            data: symbols,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_WORKSPACE_SYMBOLS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Diagnostics
    ipcMain.handle(
      IPC_CHANNELS.LSP_DIAGNOSTICS,
      async (event: IpcMainInvokeEvent, payload: LspFilePayload): Promise<IpcResponse> => {
        try {
          const diagnostics = await lsp.getDiagnostics(payload.filePath);
          return {
            success: true,
            data: diagnostics,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_DIAGNOSTICS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Check if LSP is available for a file
    ipcMain.handle(
      IPC_CHANNELS.LSP_IS_AVAILABLE,
      async (event: IpcMainInvokeEvent, payload: LspFilePayload): Promise<IpcResponse> => {
        try {
          const available = lsp.isAvailableForFile(payload.filePath);
          return {
            success: true,
            data: { available },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_IS_AVAILABLE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Shutdown all LSP clients
    ipcMain.handle(
      IPC_CHANNELS.LSP_SHUTDOWN,
      async (): Promise<IpcResponse> => {
        try {
          await lsp.shutdown();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LSP_SHUTDOWN_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register Multi-Edit handlers
   */
  private registerMultiEditHandlers(): void {
    const multiEdit = getMultiEditManager();

    // Preview edits without applying
    ipcMain.handle(
      IPC_CHANNELS.MULTIEDIT_PREVIEW,
      async (event: IpcMainInvokeEvent, payload: MultiEditPayload): Promise<IpcResponse> => {
        try {
          const preview = await multiEdit.preview(payload.edits);
          return {
            success: true,
            data: preview,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MULTIEDIT_PREVIEW_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Apply edits atomically
    ipcMain.handle(
      IPC_CHANNELS.MULTIEDIT_APPLY,
      async (event: IpcMainInvokeEvent, payload: MultiEditPayload): Promise<IpcResponse> => {
        try {
          const result = await multiEdit.apply(payload.edits, {
            instanceId: payload.instanceId,
            takeSnapshots: payload.takeSnapshots,
          });
          return {
            success: result.success,
            data: result,
            error: result.success
              ? undefined
              : {
                  code: 'MULTIEDIT_APPLY_FAILED',
                  message: result.error || 'Unknown error',
                  timestamp: Date.now(),
                },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'MULTIEDIT_APPLY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register Bash validation handlers
   */
  private registerBashHandlers(): void {
    const bashValidator = getBashValidator();

    // Validate a bash command
    ipcMain.handle(
      IPC_CHANNELS.BASH_VALIDATE,
      async (_event: IpcMainInvokeEvent, command: string): Promise<IpcResponse> => {
        try {
          const result = bashValidator.validate(command);
          return {
            success: true,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'BASH_VALIDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get bash validator config
    ipcMain.handle(
      IPC_CHANNELS.BASH_GET_CONFIG,
      async (): Promise<IpcResponse> => {
        try {
          const config = bashValidator.getConfig();
          // Serialize RegExp patterns to strings for IPC
          const serializedConfig = {
            ...config,
            warningPatterns: config.warningPatterns.map((p) =>
              p instanceof RegExp ? p.source : p
            ),
            blockedPatterns: config.blockedPatterns.map((p) =>
              p instanceof RegExp ? p.source : p
            ),
          };
          return {
            success: true,
            data: serializedConfig,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'BASH_GET_CONFIG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Add an allowed command
    ipcMain.handle(
      IPC_CHANNELS.BASH_ADD_ALLOWED,
      async (_event: IpcMainInvokeEvent, command: string): Promise<IpcResponse> => {
        try {
          bashValidator.addAllowedCommand(command);
          return {
            success: true,
            data: { command, added: true },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'BASH_ADD_ALLOWED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Add a blocked command
    ipcMain.handle(
      IPC_CHANNELS.BASH_ADD_BLOCKED,
      async (_event: IpcMainInvokeEvent, command: string): Promise<IpcResponse> => {
        try {
          bashValidator.addBlockedCommand(command);
          return {
            success: true,
            data: { command, added: true },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'BASH_ADD_BLOCKED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register task management handlers (subagent spawning)
   */
  private registerTaskHandlers(): void {
    const taskManager = getTaskManager();

    // Get task status by ID
    ipcMain.handle(
      IPC_CHANNELS.TASK_GET_STATUS,
      async (_event: IpcMainInvokeEvent, payload: TaskGetStatusPayload): Promise<IpcResponse> => {
        try {
          const task = taskManager.getTask(payload.taskId);
          return {
            success: true,
            data: task ? taskManager.serializeTask(task) : null,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_GET_STATUS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get task history
    ipcMain.handle(
      IPC_CHANNELS.TASK_GET_HISTORY,
      async (_event: IpcMainInvokeEvent, payload: TaskGetHistoryPayload): Promise<IpcResponse> => {
        try {
          const history = taskManager.getTaskHistory(payload.parentId);
          return {
            success: true,
            data: history,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_GET_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get tasks by parent instance
    ipcMain.handle(
      IPC_CHANNELS.TASK_GET_BY_PARENT,
      async (_event: IpcMainInvokeEvent, payload: TaskGetByParentPayload): Promise<IpcResponse> => {
        try {
          const tasks = taskManager.getTasksByParentId(payload.parentId);
          return {
            success: true,
            data: tasks.map((t) => taskManager.serializeTask(t)),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_GET_BY_PARENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get task by child instance
    ipcMain.handle(
      IPC_CHANNELS.TASK_GET_BY_CHILD,
      async (_event: IpcMainInvokeEvent, payload: TaskGetByChildPayload): Promise<IpcResponse> => {
        try {
          const task = taskManager.getTaskByChildId(payload.childId);
          return {
            success: true,
            data: task ? taskManager.serializeTask(task) : null,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_GET_BY_CHILD_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Cancel a task
    ipcMain.handle(
      IPC_CHANNELS.TASK_CANCEL,
      async (_event: IpcMainInvokeEvent, payload: TaskCancelPayload): Promise<IpcResponse> => {
        try {
          const success = taskManager.cancelTask(payload.taskId);
          return {
            success: true,
            data: { cancelled: success },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_CANCEL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get task queue
    ipcMain.handle(
      IPC_CHANNELS.TASK_GET_QUEUE,
      async (): Promise<IpcResponse> => {
        try {
          const stats = taskManager.getStats();
          return {
            success: true,
            data: stats,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'TASK_GET_QUEUE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Register security handlers (secret detection & env filtering)
   */
  private registerSecurityHandlers(): void {
    // Detect secrets in content
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_DETECT_SECRETS,
      async (_event: IpcMainInvokeEvent, payload: SecurityDetectSecretsPayload): Promise<IpcResponse> => {
        try {
          let secrets;
          if (payload.contentType === 'env') {
            secrets = detectSecretsInEnvContent(payload.content);
          } else if (payload.contentType === 'text') {
            secrets = detectSecretsInContent(payload.content);
          } else {
            // Auto-detect: if content looks like .env format, use env parser
            const looksLikeEnv = payload.content.split('\n').some((line) =>
              /^[A-Z_][A-Z0-9_]*=/.test(line.trim())
            );
            secrets = looksLikeEnv
              ? detectSecretsInEnvContent(payload.content)
              : detectSecretsInContent(payload.content);
          }
          return {
            success: true,
            data: secrets,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_DETECT_SECRETS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Redact secrets in content
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_REDACT_CONTENT,
      async (_event: IpcMainInvokeEvent, payload: SecurityRedactContentPayload): Promise<IpcResponse> => {
        try {
          let redacted;
          if (payload.contentType === 'env') {
            redacted = redactEnvContent(payload.content, payload.options);
          } else {
            redacted = redactAllSecrets(payload.content, payload.options);
          }
          return {
            success: true,
            data: { redacted },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_REDACT_CONTENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Check if a file path is sensitive
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_CHECK_FILE,
      async (_event: IpcMainInvokeEvent, payload: SecurityCheckFilePayload): Promise<IpcResponse> => {
        try {
          return {
            success: true,
            data: {
              isSecretFile: isSecretFile(payload.filePath),
              sensitivity: getFileSensitivity(payload.filePath),
            },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_CHECK_FILE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get secret access audit log
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_GET_AUDIT_LOG,
      async (_event: IpcMainInvokeEvent, payload: SecurityGetAuditLogPayload): Promise<IpcResponse> => {
        try {
          const auditLog = getSecretAuditLog();
          const records = payload.instanceId
            ? auditLog.getRecordsByInstance(payload.instanceId, payload.limit)
            : auditLog.getRecords(payload.limit);
          return {
            success: true,
            data: records,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_GET_AUDIT_LOG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear audit log
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_CLEAR_AUDIT_LOG,
      async (): Promise<IpcResponse> => {
        try {
          const auditLog = getSecretAuditLog();
          auditLog.clear();
          return {
            success: true,
            data: { cleared: true },
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_CLEAR_AUDIT_LOG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get safe environment variables
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_GET_SAFE_ENV,
      async (): Promise<IpcResponse> => {
        try {
          const safeEnv = getSafeEnv();
          return {
            success: true,
            data: safeEnv,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_GET_SAFE_ENV_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Check if a single env var should be allowed
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_CHECK_ENV_VAR,
      async (_event: IpcMainInvokeEvent, payload: SecurityCheckEnvVarPayload): Promise<IpcResponse> => {
        try {
          const result = shouldAllowEnvVar(payload.name, payload.value);
          return {
            success: true,
            data: result,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_CHECK_ENV_VAR_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get env filter config
    ipcMain.handle(
      IPC_CHANNELS.SECURITY_GET_ENV_FILTER_CONFIG,
      async (): Promise<IpcResponse> => {
        try {
          // Serialize config (convert RegExp to strings)
          const config = {
            ...DEFAULT_ENV_FILTER_CONFIG,
            blockPatterns: DEFAULT_ENV_FILTER_CONFIG.blockPatterns.map((p) => p.source),
            allowPatterns: DEFAULT_ENV_FILTER_CONFIG.allowPatterns.map((p) => p.source),
          };
          return {
            success: true,
            data: config,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SECURITY_GET_ENV_FILTER_CONFIG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // Cost Tracking Handlers (5.3)
  // ============================================================================

  /**
   * Register cost tracking handlers
   */
  private registerCostHandlers(): void {
    const costTracker = getCostTracker();

    // Record usage
    ipcMain.handle(
      IPC_CHANNELS.COST_RECORD_USAGE,
      async (_event: IpcMainInvokeEvent, payload: CostRecordUsagePayload): Promise<IpcResponse> => {
        try {
          costTracker.recordUsage(
            payload.instanceId,
            payload.sessionId,
            payload.model,
            payload.inputTokens,
            payload.outputTokens,
            payload.cacheReadTokens,
            payload.cacheWriteTokens
          );
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_RECORD_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get summary
    ipcMain.handle(
      IPC_CHANNELS.COST_GET_SUMMARY,
      async (_event: IpcMainInvokeEvent, payload: CostGetSummaryPayload): Promise<IpcResponse> => {
        try {
          const summary = costTracker.getSummary(payload?.startTime, payload?.endTime);
          return { success: true, data: summary };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_GET_SUMMARY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get session cost
    ipcMain.handle(
      IPC_CHANNELS.COST_GET_SESSION_COST,
      async (_event: IpcMainInvokeEvent, payload: CostGetSessionCostPayload): Promise<IpcResponse> => {
        try {
          const cost = costTracker.getSessionCost(payload.sessionId);
          return { success: true, data: cost };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_GET_SESSION_COST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get budget
    ipcMain.handle(
      IPC_CHANNELS.COST_GET_BUDGET,
      async (): Promise<IpcResponse> => {
        try {
          const budget = costTracker.getBudget();
          return { success: true, data: budget };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_GET_BUDGET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Set budget
    ipcMain.handle(
      IPC_CHANNELS.COST_SET_BUDGET,
      async (_event: IpcMainInvokeEvent, payload: CostSetBudgetPayload): Promise<IpcResponse> => {
        try {
          costTracker.setBudget(payload);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_SET_BUDGET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get budget status
    ipcMain.handle(
      IPC_CHANNELS.COST_GET_BUDGET_STATUS,
      async (): Promise<IpcResponse> => {
        try {
          const status = costTracker.getBudgetStatus();
          return { success: true, data: status };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_GET_BUDGET_STATUS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get entries
    ipcMain.handle(
      IPC_CHANNELS.COST_GET_ENTRIES,
      async (_event: IpcMainInvokeEvent, payload: CostGetEntriesPayload): Promise<IpcResponse> => {
        try {
          const entries = costTracker.getEntries(payload?.limit);
          return { success: true, data: entries };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_GET_ENTRIES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear entries
    ipcMain.handle(
      IPC_CHANNELS.COST_CLEAR_ENTRIES,
      async (): Promise<IpcResponse> => {
        try {
          costTracker.clearEntries();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'COST_CLEAR_ENTRIES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Forward cost events to renderer
    costTracker.on('usage-recorded', (data) => {
      this.windowManager.getMainWindow()?.webContents.send('cost:usage-recorded', data);
    });

    costTracker.on('budget-warning', (data) => {
      this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.COST_BUDGET_ALERT, data);
    });

    costTracker.on('budget-exceeded', (data) => {
      this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.COST_BUDGET_ALERT, data);
    });
  }

  // ============================================================================
  // Session Archive Handlers (1.3)
  // ============================================================================

  /**
   * Register session archive handlers
   */
  private registerArchiveHandlers(): void {
    const archiveManager = getSessionArchiveManager();

    // Archive session - requires an Instance object
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_SESSION,
      async (_event: IpcMainInvokeEvent, payload: ArchiveSessionPayload): Promise<IpcResponse> => {
        try {
          // Get the instance from instance manager
          const instance = this.instanceManager.getInstance(payload.instanceId);
          if (!instance) {
            throw new Error(`Instance not found: ${payload.instanceId}`);
          }
          const meta = archiveManager.archiveSession(instance, payload.tags);
          return { success: true, data: meta };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_SESSION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // List archives
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_LIST,
      async (_event: IpcMainInvokeEvent, payload: ArchiveListPayload): Promise<IpcResponse> => {
        try {
          const filter = payload ? {
            beforeDate: payload.beforeDate,
            afterDate: payload.afterDate,
            tags: payload.tags,
            searchTerm: payload.searchTerm,
          } : undefined;
          const archives = archiveManager.listArchivedSessions(filter);
          return { success: true, data: archives };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_LIST_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Restore archive
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_RESTORE,
      async (_event: IpcMainInvokeEvent, payload: ArchiveRestorePayload): Promise<IpcResponse> => {
        try {
          const sessionData = archiveManager.restoreSession(payload.sessionId);
          return { success: true, data: sessionData };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_RESTORE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Delete archive
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_DELETE,
      async (_event: IpcMainInvokeEvent, payload: ArchiveDeletePayload): Promise<IpcResponse> => {
        try {
          const success = archiveManager.deleteArchivedSession(payload.sessionId);
          return { success: true, data: { deleted: success } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_DELETE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get archive metadata
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_GET_META,
      async (_event: IpcMainInvokeEvent, payload: ArchiveGetMetaPayload): Promise<IpcResponse> => {
        try {
          const meta = archiveManager.getArchivedSessionMeta(payload.sessionId);
          return { success: true, data: meta };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_GET_META_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Update tags
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_UPDATE_TAGS,
      async (_event: IpcMainInvokeEvent, payload: ArchiveUpdateTagsPayload): Promise<IpcResponse> => {
        try {
          const success = archiveManager.updateTags(payload.sessionId, payload.tags);
          return { success: true, data: { updated: success } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_UPDATE_TAGS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get archive stats
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_GET_STATS,
      async (): Promise<IpcResponse> => {
        try {
          const stats = archiveManager.getArchiveStats();
          return { success: true, data: stats };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_GET_STATS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Cleanup old archives
    ipcMain.handle(
      IPC_CHANNELS.ARCHIVE_CLEANUP,
      async (_event: IpcMainInvokeEvent, payload: ArchiveCleanupPayload): Promise<IpcResponse> => {
        try {
          const deleted = archiveManager.cleanupOldArchives(payload.maxAgeDays);
          return { success: true, data: { deletedCount: deleted } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'ARCHIVE_CLEANUP_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // Remote Config Handlers (6.2)
  // ============================================================================

  /**
   * Register remote config handlers
   */
  private registerRemoteConfigHandlers(): void {
    const remoteConfigManager = getRemoteConfigManager();

    // Fetch config from URL
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_FETCH_URL,
      async (_event: IpcMainInvokeEvent, payload: RemoteConfigFetchUrlPayload): Promise<IpcResponse> => {
        try {
          const config = await remoteConfigManager.fetchFromUrl(payload.url, {
            timeout: payload.timeout,
            cacheTTL: payload.cacheTTL,
            maxRetries: payload.maxRetries,
            useCache: payload.useCache,
          });
          return { success: true, data: config };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_FETCH_URL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Fetch from well-known endpoint
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_FETCH_WELL_KNOWN,
      async (_event: IpcMainInvokeEvent, payload: RemoteConfigFetchWellKnownPayload): Promise<IpcResponse> => {
        try {
          const config = await remoteConfigManager.fetchFromWellKnown(payload.domain, {
            timeout: payload.timeout,
            cacheTTL: payload.cacheTTL,
          });
          return { success: true, data: config };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_FETCH_WELL_KNOWN_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Fetch from GitHub
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_FETCH_GITHUB,
      async (_event: IpcMainInvokeEvent, payload: RemoteConfigFetchGitHubPayload): Promise<IpcResponse> => {
        try {
          const config = await remoteConfigManager.fetchFromGitHub(
            payload.owner,
            payload.repo,
            payload.branch
          );
          return { success: true, data: config };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_FETCH_GITHUB_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Discover config for git repo
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_DISCOVER_GIT,
      async (_event: IpcMainInvokeEvent, payload: RemoteConfigDiscoverGitPayload): Promise<IpcResponse> => {
        try {
          const config = await remoteConfigManager.discoverForGitRepo(payload.gitRemoteUrl);
          return { success: true, data: config };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_DISCOVER_GIT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get cached configs
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_GET_CACHED,
      async (): Promise<IpcResponse> => {
        try {
          const cached = remoteConfigManager.getCachedConfigs();
          return { success: true, data: cached };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_GET_CACHED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear cache
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_CLEAR_CACHE,
      async (): Promise<IpcResponse> => {
        try {
          remoteConfigManager.clearCache();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_CLEAR_CACHE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Invalidate specific cache entry
    ipcMain.handle(
      IPC_CHANNELS.REMOTE_CONFIG_INVALIDATE,
      async (_event: IpcMainInvokeEvent, payload: RemoteConfigInvalidatePayload): Promise<IpcResponse> => {
        try {
          remoteConfigManager.invalidateCache(payload.url);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'REMOTE_CONFIG_INVALIDATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // External Editor Handlers (9.2)
  // ============================================================================

  /**
   * Register external editor handlers
   */
  private registerEditorHandlers(): void {
    const editorManager = getExternalEditorManager();

    // Detect available editors
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_DETECT,
      async (): Promise<IpcResponse> => {
        try {
          const editors = await editorManager.detectEditors();
          return { success: true, data: editors };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_DETECT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Open file in editor
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_OPEN_FILE,
      async (_event: IpcMainInvokeEvent, payload: EditorOpenFilePayload): Promise<IpcResponse> => {
        try {
          const result = await editorManager.openFile(payload.filePath, {
            line: payload.line,
            column: payload.column,
            waitForClose: payload.waitForClose,
            newWindow: payload.newWindow,
          });
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_OPEN_FILE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Open file at specific line
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_OPEN_FILE_AT_LINE,
      async (_event: IpcMainInvokeEvent, payload: EditorOpenFileAtLinePayload): Promise<IpcResponse> => {
        try {
          const result = await editorManager.openFileAtLine(
            payload.filePath,
            payload.line,
            payload.column
          );
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_OPEN_FILE_AT_LINE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Open directory in editor
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_OPEN_DIRECTORY,
      async (_event: IpcMainInvokeEvent, payload: EditorOpenDirectoryPayload): Promise<IpcResponse> => {
        try {
          const result = await editorManager.openDirectory(payload.dirPath);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_OPEN_DIRECTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Set preferred editor
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_SET_PREFERRED,
      async (_event: IpcMainInvokeEvent, payload: EditorSetPreferredPayload): Promise<IpcResponse> => {
        try {
          editorManager.setPreferredEditor({
            type: payload.type as import('../editor/external-editor').EditorType,
            path: payload.path,
            args: payload.args,
          });
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_SET_PREFERRED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get preferred editor
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_GET_PREFERRED,
      async (): Promise<IpcResponse> => {
        try {
          const editor = editorManager.getPreferredEditor();
          return { success: true, data: editor };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_GET_PREFERRED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get available editors
    ipcMain.handle(
      IPC_CHANNELS.EDITOR_GET_AVAILABLE,
      async (): Promise<IpcResponse> => {
        try {
          const editors = editorManager.getAvailableEditors();
          return { success: true, data: editors };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'EDITOR_GET_AVAILABLE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // File Watcher Handlers (10.1)
  // ============================================================================

  /**
   * Register file watcher handlers
   */
  private registerWatcherHandlers(): void {
    const watcherManager = getFileWatcherManager();

    // Start watching
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_START,
      async (_event: IpcMainInvokeEvent, payload: WatcherStartPayload): Promise<IpcResponse> => {
        try {
          const sessionId = await watcherManager.watch(payload.directory, {
            ignored: payload.ignored,
            useGitignore: payload.useGitignore,
            depth: payload.depth,
            ignoreInitial: payload.ignoreInitial,
          });
          return { success: true, data: { sessionId } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_START_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Stop watching
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_STOP,
      async (_event: IpcMainInvokeEvent, payload: WatcherStopPayload): Promise<IpcResponse> => {
        try {
          await watcherManager.unwatch(payload.sessionId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_STOP_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Stop all watchers
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_STOP_ALL,
      async (): Promise<IpcResponse> => {
        try {
          await watcherManager.unwatchAll();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_STOP_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get active sessions
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_GET_SESSIONS,
      async (): Promise<IpcResponse> => {
        try {
          const sessions = watcherManager.getActiveSessions();
          return { success: true, data: sessions };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_GET_SESSIONS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get recent changes
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_GET_CHANGES,
      async (_event: IpcMainInvokeEvent, payload: WatcherGetChangesPayload): Promise<IpcResponse> => {
        try {
          const changes = watcherManager.getRecentChanges(payload.sessionId, payload.limit);
          return { success: true, data: changes };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_GET_CHANGES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear event buffer
    ipcMain.handle(
      IPC_CHANNELS.WATCHER_CLEAR_BUFFER,
      async (_event: IpcMainInvokeEvent, payload: WatcherClearBufferPayload): Promise<IpcResponse> => {
        try {
          watcherManager.clearEventBuffer(payload.sessionId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'WATCHER_CLEAR_BUFFER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Forward watcher events to renderer
    watcherManager.on('file-changed', (data) => {
      this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
    });

    watcherManager.on('file-added', (data) => {
      this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
    });

    watcherManager.on('file-removed', (data) => {
      this.windowManager.getMainWindow()?.webContents.send(IPC_CHANNELS.WATCHER_FILE_CHANGED, data);
    });

    watcherManager.on('error', (data) => {
      this.windowManager.getMainWindow()?.webContents.send('watcher:error', data);
    });
  }

  // ============================================================================
  // Logging Handlers (13.1)
  // ============================================================================

  /**
   * Register logging handlers
   */
  private registerLoggingHandlers(): void {
    const logManager = getLogManager();

    // Get recent logs
    ipcMain.handle(
      IPC_CHANNELS.LOG_GET_RECENT,
      async (_event: IpcMainInvokeEvent, payload: LogGetRecentPayload): Promise<IpcResponse> => {
        try {
          const logs = logManager.getRecentLogs({
            limit: payload?.limit,
            level: payload?.level ? this.mapLogLevel(payload.level) : undefined,
            subsystem: payload?.subsystem,
            startTime: payload?.startTime,
            endTime: payload?.endTime,
          });
          return { success: true, data: logs };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_GET_RECENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get config
    ipcMain.handle(
      IPC_CHANNELS.LOG_GET_CONFIG,
      async (): Promise<IpcResponse> => {
        try {
          const config = logManager.getConfig();
          return { success: true, data: config };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_GET_CONFIG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Set global log level
    ipcMain.handle(
      IPC_CHANNELS.LOG_SET_LEVEL,
      async (_event: IpcMainInvokeEvent, payload: LogSetLevelPayload): Promise<IpcResponse> => {
        try {
          logManager.setGlobalLevel(this.mapLogLevel(payload.level));
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_SET_LEVEL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Set subsystem log level
    ipcMain.handle(
      IPC_CHANNELS.LOG_SET_SUBSYSTEM_LEVEL,
      async (_event: IpcMainInvokeEvent, payload: LogSetSubsystemLevelPayload): Promise<IpcResponse> => {
        try {
          logManager.setSubsystemLevel(payload.subsystem, this.mapLogLevel(payload.level));
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_SET_SUBSYSTEM_LEVEL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear log buffer
    ipcMain.handle(
      IPC_CHANNELS.LOG_CLEAR_BUFFER,
      async (): Promise<IpcResponse> => {
        try {
          logManager.clearBuffer();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_CLEAR_BUFFER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Export logs
    ipcMain.handle(
      IPC_CHANNELS.LOG_EXPORT,
      async (_event: IpcMainInvokeEvent, payload: LogExportPayload): Promise<IpcResponse> => {
        try {
          logManager.exportLogs(payload.filePath, {
            startTime: payload.startTime,
            endTime: payload.endTime,
          });
          return { success: true, data: { filePath: payload.filePath } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_EXPORT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get subsystems
    ipcMain.handle(
      IPC_CHANNELS.LOG_GET_SUBSYSTEMS,
      async (): Promise<IpcResponse> => {
        try {
          const subsystems = logManager.getSubsystems();
          return { success: true, data: subsystems };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_GET_SUBSYSTEMS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get log files
    ipcMain.handle(
      IPC_CHANNELS.LOG_GET_FILES,
      async (): Promise<IpcResponse> => {
        try {
          const files = logManager.getLogFilePaths();
          return { success: true, data: files };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'LOG_GET_FILES_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  /**
   * Map log level string to LogLevel type
   */
  private mapLogLevel(level: string): 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
    const validLevels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;
    if (validLevels.includes(level as typeof validLevels[number])) {
      return level as 'debug' | 'info' | 'warn' | 'error' | 'fatal';
    }
    return 'info';
  }

  // ============================================================================
  // Debug Command Handlers (13.2)
  // ============================================================================

  /**
   * Register debug command handlers
   */
  private registerDebugHandlers(): void {
    const debugManager = getDebugCommandsManager();

    // Debug agent
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_AGENT,
      async (_event: IpcMainInvokeEvent, payload: DebugAgentPayload): Promise<IpcResponse> => {
        try {
          const result = await debugManager.debugAgent(payload.agentId);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_AGENT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug config
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_CONFIG,
      async (_event: IpcMainInvokeEvent, payload: DebugConfigPayload): Promise<IpcResponse> => {
        try {
          const result = await debugManager.debugConfig(payload.workingDirectory);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_CONFIG_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug file
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_FILE,
      async (_event: IpcMainInvokeEvent, payload: DebugFilePayload): Promise<IpcResponse> => {
        try {
          const result = await debugManager.debugFile(payload.filePath);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_FILE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug memory
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_MEMORY,
      async (): Promise<IpcResponse> => {
        try {
          const result = debugManager.debugMemory();
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_MEMORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug system
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_SYSTEM,
      async (): Promise<IpcResponse> => {
        try {
          const result = debugManager.debugSystem();
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_SYSTEM_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug process
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_PROCESS,
      async (): Promise<IpcResponse> => {
        try {
          const result = debugManager.debugProcess();
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_PROCESS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Debug all
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_ALL,
      async (_event: IpcMainInvokeEvent, payload: DebugAllPayload): Promise<IpcResponse> => {
        try {
          const result = await debugManager.debugAll(payload.workingDirectory);
          return { success: true, data: result };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get memory history
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_GET_MEMORY_HISTORY,
      async (): Promise<IpcResponse> => {
        try {
          const history = debugManager.getMemoryHistory();
          return { success: true, data: history };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_GET_MEMORY_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear memory history
    ipcMain.handle(
      IPC_CHANNELS.DEBUG_CLEAR_MEMORY_HISTORY,
      async (): Promise<IpcResponse> => {
        try {
          debugManager.clearMemoryHistory();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'DEBUG_CLEAR_MEMORY_HISTORY_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // Usage Stats Handlers (14.1)
  // ============================================================================

  /**
   * Register usage stats handlers
   */
  private registerStatsHandlers(): void {
    const statsManager = getUsageStatsManager();

    // Record session start
    ipcMain.handle(
      IPC_CHANNELS.STATS_RECORD_SESSION_START,
      async (_event: IpcMainInvokeEvent, payload: StatsRecordSessionStartPayload): Promise<IpcResponse> => {
        try {
          statsManager.recordSessionStart(
            payload.sessionId,
            payload.instanceId,
            payload.agentId,
            payload.workingDirectory
          );
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_RECORD_SESSION_START_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Record session end
    ipcMain.handle(
      IPC_CHANNELS.STATS_RECORD_SESSION_END,
      async (_event: IpcMainInvokeEvent, payload: StatsRecordSessionEndPayload): Promise<IpcResponse> => {
        try {
          statsManager.recordSessionEnd(payload.sessionId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_RECORD_SESSION_END_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Record message
    ipcMain.handle(
      IPC_CHANNELS.STATS_RECORD_MESSAGE,
      async (_event: IpcMainInvokeEvent, payload: StatsRecordMessagePayload): Promise<IpcResponse> => {
        try {
          statsManager.recordMessage(
            payload.sessionId,
            payload.inputTokens,
            payload.outputTokens,
            payload.cost
          );
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_RECORD_MESSAGE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Record tool usage
    ipcMain.handle(
      IPC_CHANNELS.STATS_RECORD_TOOL_USAGE,
      async (_event: IpcMainInvokeEvent, payload: StatsRecordToolUsagePayload): Promise<IpcResponse> => {
        try {
          statsManager.recordToolUsage(payload.sessionId, payload.tool);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_RECORD_TOOL_USAGE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get stats
    ipcMain.handle(
      IPC_CHANNELS.STATS_GET,
      async (_event: IpcMainInvokeEvent, payload: StatsGetPayload): Promise<IpcResponse> => {
        try {
          const stats = statsManager.getStats(payload.period);
          return { success: true, data: stats };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_GET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get session stats
    ipcMain.handle(
      IPC_CHANNELS.STATS_GET_SESSION,
      async (_event: IpcMainInvokeEvent, payload: StatsGetSessionPayload): Promise<IpcResponse> => {
        try {
          const stats = statsManager.getSessionStats(payload.sessionId);
          return { success: true, data: stats };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_GET_SESSION_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get active sessions
    ipcMain.handle(
      IPC_CHANNELS.STATS_GET_ACTIVE_SESSIONS,
      async (): Promise<IpcResponse> => {
        try {
          const sessions = statsManager.getActiveSessions();
          return { success: true, data: sessions };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_GET_ACTIVE_SESSIONS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get tool usage
    ipcMain.handle(
      IPC_CHANNELS.STATS_GET_TOOL_USAGE,
      async (): Promise<IpcResponse> => {
        try {
          const usage = statsManager.getToolUsage();
          return { success: true, data: usage };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_GET_TOOL_USAGE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Export stats
    ipcMain.handle(
      IPC_CHANNELS.STATS_EXPORT,
      async (_event: IpcMainInvokeEvent, payload: StatsExportPayload): Promise<IpcResponse> => {
        try {
          statsManager.exportStats(payload.filePath, payload.period);
          return { success: true, data: { exportPath: payload.filePath } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_EXPORT_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear stats
    ipcMain.handle(
      IPC_CHANNELS.STATS_CLEAR,
      async (): Promise<IpcResponse> => {
        try {
          statsManager.clearStats();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_CLEAR_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get storage usage
    ipcMain.handle(
      IPC_CHANNELS.STATS_GET_STORAGE,
      async (): Promise<IpcResponse> => {
        try {
          const storage = statsManager.getStorageUsage();
          return { success: true, data: storage };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'STATS_GET_STORAGE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // Semantic Search Handlers (4.7)
  // ============================================================================

  /**
   * Register semantic search handlers
   */
  private registerSearchHandlers(): void {
    const searchManager = getSemanticSearchManager();

    // Search
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_SEMANTIC,
      async (_event: IpcMainInvokeEvent, payload: SearchSemanticPayload): Promise<IpcResponse> => {
        try {
          const results = await searchManager.search({
            query: payload.query,
            directory: payload.directory,
            maxResults: payload.maxResults,
            includePatterns: payload.includePatterns,
            excludePatterns: payload.excludePatterns,
            searchType: payload.searchType,
          });
          return { success: true, data: results };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_SEMANTIC_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Build index
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_BUILD_INDEX,
      async (_event: IpcMainInvokeEvent, payload: SearchBuildIndexPayload): Promise<IpcResponse> => {
        try {
          await searchManager.buildIndex(
            payload.directory,
            payload.includePatterns || ['**/*.ts', '**/*.js', '**/*.py'],
            payload.excludePatterns || ['**/node_modules/**', '**/.git/**']
          );
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_BUILD_INDEX_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Configure Exa
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_CONFIGURE_EXA,
      async (_event: IpcMainInvokeEvent, payload: SearchConfigureExaPayload): Promise<IpcResponse> => {
        try {
          searchManager.configureExa({
            apiKey: payload.apiKey,
            baseUrl: payload.baseUrl,
          });
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_CONFIGURE_EXA_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Clear index
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_CLEAR_INDEX,
      async (): Promise<IpcResponse> => {
        try {
          searchManager.clearIndex();
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_CLEAR_INDEX_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get index stats
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_GET_INDEX_STATS,
      async (): Promise<IpcResponse> => {
        try {
          const stats = searchManager.getIndexStats();
          return { success: true, data: stats };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_GET_INDEX_STATS_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Check if Exa is configured
    ipcMain.handle(
      IPC_CHANNELS.SEARCH_IS_EXA_CONFIGURED,
      async (): Promise<IpcResponse> => {
        try {
          const isConfigured = searchManager.isExaConfigured();
          return { success: true, data: isConfigured };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'SEARCH_IS_EXA_CONFIGURED_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );
  }

  // ============================================================================
  // Provider Plugin Handlers (12.2)
  // ============================================================================

  /**
   * Register provider plugin handlers
   */
  private registerPluginHandlers(): void {
    const pluginManager = getProviderPluginsManager();

    // Discover plugins
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_DISCOVER,
      async (): Promise<IpcResponse> => {
        try {
          const plugins = await pluginManager.discoverPlugins();
          return { success: true, data: plugins };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_DISCOVER_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Load plugin
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_LOAD,
      async (_event: IpcMainInvokeEvent, payload: PluginsLoadPayload): Promise<IpcResponse> => {
        try {
          const plugin = await pluginManager.loadPlugin(payload.idOrPath, {
            timeout: payload.timeout,
            sandbox: payload.sandbox,
          });
          return { success: true, data: plugin ? pluginManager.pluginToProviderConfig(plugin) : null };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_LOAD_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Unload plugin
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_UNLOAD,
      async (_event: IpcMainInvokeEvent, payload: PluginsUnloadPayload): Promise<IpcResponse> => {
        try {
          await pluginManager.unloadPlugin(payload.pluginId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_UNLOAD_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Install plugin
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_INSTALL,
      async (_event: IpcMainInvokeEvent, payload: PluginsInstallPayload): Promise<IpcResponse> => {
        try {
          const meta = await pluginManager.installPlugin(payload.sourcePath);
          return { success: true, data: meta };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_INSTALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Uninstall plugin
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_UNINSTALL,
      async (_event: IpcMainInvokeEvent, payload: PluginsUninstallPayload): Promise<IpcResponse> => {
        try {
          await pluginManager.uninstallPlugin(payload.pluginId);
          return { success: true };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_UNINSTALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get a specific plugin
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_GET,
      async (_event: IpcMainInvokeEvent, payload: PluginsGetPayload): Promise<IpcResponse> => {
        try {
          const plugin = pluginManager.getPlugin(payload.pluginId);
          return {
            success: true,
            data: plugin ? pluginManager.pluginToProviderConfig(plugin) : null,
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_GET_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get all loaded plugins
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_GET_ALL,
      async (): Promise<IpcResponse> => {
        try {
          const plugins = pluginManager.getLoadedPlugins();
          return {
            success: true,
            data: plugins.map((p) => pluginManager.pluginToProviderConfig(p)),
          };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_GET_ALL_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Get plugin metadata
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_GET_META,
      async (_event: IpcMainInvokeEvent, payload: PluginsGetMetaPayload): Promise<IpcResponse> => {
        try {
          const allMeta = pluginManager.getAllPluginMeta();
          const meta = allMeta.find((m) => m.id === payload.pluginId);
          return { success: true, data: meta || null };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_GET_META_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Create plugin template
    ipcMain.handle(
      IPC_CHANNELS.PLUGINS_CREATE_TEMPLATE,
      async (_event: IpcMainInvokeEvent, payload: PluginsCreateTemplatePayload): Promise<IpcResponse> => {
        try {
          const filePath = pluginManager.savePluginTemplate(payload.name);
          return { success: true, data: { filePath } };
        } catch (error) {
          return {
            success: false,
            error: {
              code: 'PLUGINS_CREATE_TEMPLATE_FAILED',
              message: (error as Error).message,
              timestamp: Date.now(),
            },
          };
        }
      }
    );

    // Forward plugin events to renderer
    pluginManager.on('plugin-loaded', (pluginId) => {
      this.windowManager.getMainWindow()?.webContents.send('plugins:loaded', { pluginId });
    });

    pluginManager.on('plugin-unloaded', (pluginId) => {
      this.windowManager.getMainWindow()?.webContents.send('plugins:unloaded', { pluginId });
    });

    pluginManager.on('plugin-error', (pluginId, error) => {
      this.windowManager.getMainWindow()?.webContents.send('plugins:error', { pluginId, error: error.message });
    });
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
