/**
 * MCP (Model Context Protocol) IPC Handlers
 * Handles MCP server management and operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getMcpManager } from '../../mcp/mcp-manager';
import { getMcpLifecycleManager } from '../../mcp/mcp-lifecycle-manager';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  McpAddServerPayloadSchema,
  McpCallToolPayloadSchema,
  McpGetServersPayloadSchema,
  McpGetPromptPayloadSchema,
  McpReadResourcePayloadSchema,
  McpServerPayloadSchema,
  McpSetServerEnabledPayloadSchema,
} from '@contracts/schemas/provider';
import {
  McpDeletePayloadSchema,
  McpDriftQuerySchema,
  McpFanOutPayloadSchema,
  McpInjectionTargetsPayloadSchema,
  McpProviderScopePayloadSchema,
  McpProviderUserDeletePayloadSchema,
  McpProviderUserUpsertPayloadSchema,
  McpResolveDriftPayloadSchema,
  OrchestratorMcpServerUpsertSchema,
  SharedMcpServerUpsertSchema,
} from '@contracts/schemas/mcp-multi-provider';
import { MCP_SERVER_PRESETS } from '../../../shared/types/mcp.types';
import type { McpServerConfig } from '../../../shared/types/mcp.types';
import type { OrchestratorMcpServer } from '../../../shared/types/mcp-orchestrator.types';
import { WindowManager } from '../../window-manager';
import { getBrowserAutomationHealthService } from '../../browser-automation/browser-automation-health';
import {
  discoverProviderMcpServers,
  setProviderMcpServerEnabled,
} from '../../mcp/provider-mcp-config-discovery';
import {
  getCliMcpConfigService,
  getOrchestratorMcpRepository,
  getSharedMcpCoordinator,
} from '../../mcp/mcp-multi-provider-singletons';
import { getLogger } from '../../logging/logger';

const logger = getLogger('McpHandlers');

export function registerMcpHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const mcp = getMcpManager();
  const lifecycle = getMcpLifecycleManager();

  const broadcastMultiProviderState = async (): Promise<void> => {
    const state = await getCliMcpConfigService().getMultiProviderState();
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_MULTI_PROVIDER_STATE_CHANGED, state);
  };

  try {
    for (const { record } of getOrchestratorMcpRepository().list()) {
      if (!mcp.getServerStatus(record.id)) {
        mcp.addServer(toMcpManagerConfig(record));
      }
    }
  } catch (error) {
    logger.warn('Failed to hydrate persisted Orchestrator MCP servers', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Set up event forwarding to renderer
  mcp.on('server:connected', (serverId) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, {
        serverId,
        status: 'connected'
      });
  });

  mcp.on('server:disconnected', (serverId) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, {
        serverId,
        status: 'disconnected'
      });
  });

  mcp.on('server:error', (serverId, error) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, {
        serverId,
        status: 'error',
        error
      });
  });

  mcp.on('server:phase', (serverId, phase, phaseState, error) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGED, {
        serverId,
        status:
          phaseState === 'failed'
            ? 'error'
            : phase === 'ready' && phaseState === 'succeeded'
              ? 'connected'
              : 'connecting',
        phase,
        phaseState,
        ...(error ? { error } : {}),
      });
  });

  mcp.on('tools:updated', () => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_STATE_CHANGED, { type: 'tools' });
  });

  mcp.on('resources:updated', () => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_STATE_CHANGED, {
        type: 'resources'
      });
  });

  mcp.on('prompts:updated', () => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.MCP_STATE_CHANGED, { type: 'prompts' });
  });

  // Get full MCP state
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_STATE,
    async (): Promise<IpcResponse> => {
      try {
        const state = lifecycle.getState();
        return {
          success: true,
          data: state
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_STATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get all servers
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_SERVERS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const options = validateIpcPayload(
          McpGetServersPayloadSchema,
          payload,
          'MCP_GET_SERVERS',
        );
        const servers = lifecycle.getServers();
        const externalServers = options?.includeExternal
          ? await discoverProviderMcpServers()
          : [];
        return {
          success: true,
          data: [...servers, ...externalServers]
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_SERVERS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Enable or disable a provider-configured server
  ipcMain.handle(
    IPC_CHANNELS.MCP_SET_SERVER_ENABLED,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          McpSetServerEnabledPayloadSchema,
          payload,
          'MCP_SET_SERVER_ENABLED',
        );
        await setProviderMcpServerEnabled(validated.serverId, validated.enabled);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SET_SERVER_ENABLED_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Add a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_ADD_SERVER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpAddServerPayloadSchema, payload, 'MCP_ADD_SERVER');
        const config: McpServerConfig = {
          id: validated.id,
          name: validated.name,
          description: validated.description,
          source: 'orchestrator',
          sourceProvider: 'orchestrator',
          scope: 'orchestrator',
          transport: validated.transport,
          command: validated.command,
          args: validated.args,
          env: validated.env,
          url: validated.url,
          autoConnect: validated.autoConnect ?? true,
        };
        try {
          const saved = getOrchestratorMcpRepository().upsert({
            id: validated.id,
            name: validated.name,
            description: validated.description,
            scope: 'orchestrator',
            transport: validated.transport,
            command: validated.command,
            args: validated.args,
            env: validated.env,
            url: validated.url,
            autoConnect: validated.autoConnect ?? true,
          });
          await mcp.upsertServer(toMcpManagerConfig(saved.record));
          await broadcastMultiProviderState();
        } catch (error) {
          logger.warn('Falling back to in-memory MCP server add', {
            error: error instanceof Error ? error.message : String(error),
          });
          mcp.addServer(config);
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_ADD_SERVER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Remove a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_REMOVE_SERVER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpServerPayloadSchema, payload, 'MCP_REMOVE_SERVER');
        await mcp.removeServer(validated.serverId);
        try {
          getOrchestratorMcpRepository().delete(validated.serverId);
          await broadcastMultiProviderState();
        } catch (error) {
          logger.warn('Failed to remove MCP server from persistent registry', {
            serverId: validated.serverId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_REMOVE_SERVER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Connect to a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_CONNECT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpServerPayloadSchema, payload, 'MCP_CONNECT');
        await lifecycle.connect(validated.serverId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_CONNECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Disconnect from a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_DISCONNECT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpServerPayloadSchema, payload, 'MCP_DISCONNECT');
        await mcp.disconnect(validated.serverId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_DISCONNECT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Restart a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_RESTART,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpServerPayloadSchema, payload, 'MCP_RESTART');
        await lifecycle.restart(validated.serverId);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_RESTART_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
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
          data: tools
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_TOOLS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
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
          data: resources
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_RESOURCES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
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
          data: prompts
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_PROMPTS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Call a tool
  ipcMain.handle(
    IPC_CHANNELS.MCP_CALL_TOOL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpCallToolPayloadSchema, payload, 'MCP_CALL_TOOL');
        const result = await mcp.callTool({
          serverId: validated.serverId,
          toolName: validated.toolName,
          arguments: validated.arguments ?? {}
        });
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'MCP_TOOL_CALL_ERROR',
                message: result.error || 'Unknown error',
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_CALL_TOOL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Read a resource
  ipcMain.handle(
    IPC_CHANNELS.MCP_READ_RESOURCE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpReadResourcePayloadSchema, payload, 'MCP_READ_RESOURCE');
        const result = await mcp.readResource({
          serverId: validated.serverId,
          uri: validated.uri
        });
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'MCP_RESOURCE_READ_ERROR',
                message: result.error || 'Unknown error',
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_READ_RESOURCE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get a prompt
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_PROMPT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpGetPromptPayloadSchema, payload, 'MCP_GET_PROMPT');
        const result = await mcp.getPrompt({
          serverId: validated.serverId,
          promptName: validated.promptName,
          arguments: validated.arguments
        });
        return {
          success: result.success,
          data: result,
          error: result.success
            ? undefined
            : {
                code: 'MCP_PROMPT_GET_ERROR',
                message: result.error || 'Unknown error',
                timestamp: Date.now()
              }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_PROMPT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
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
        data: MCP_SERVER_PRESETS
      };
    }
  );

  // Diagnose browser automation readiness
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_BROWSER_AUTOMATION_HEALTH,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await getBrowserAutomationHealthService().diagnose(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_BROWSER_AUTOMATION_HEALTH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          }
        };
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_MULTI_PROVIDER_STATE,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: await getCliMcpConfigService().getMultiProviderState(),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_GET_MULTI_PROVIDER_STATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_REFRESH_MULTI_PROVIDER_STATE,
    async (): Promise<IpcResponse> => {
      try {
        const state = await getCliMcpConfigService().refreshMultiProviderState();
        await broadcastMultiProviderState();
        return { success: true, data: state };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_REFRESH_MULTI_PROVIDER_STATE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_ORCHESTRATOR_UPSERT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          OrchestratorMcpServerUpsertSchema,
          payload,
          'MCP_ORCHESTRATOR_UPSERT',
        );
        const saved = getCliMcpConfigService().orchestratorUpsert(validated);
        await mcp.upsertServer(toMcpManagerConfig(saved.record));
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_ORCHESTRATOR_UPSERT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_ORCHESTRATOR_DELETE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpDeletePayloadSchema, payload, 'MCP_ORCHESTRATOR_DELETE');
        getCliMcpConfigService().orchestratorDelete(validated.serverId);
        await mcp.removeServer(validated.serverId);
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_ORCHESTRATOR_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_ORCHESTRATOR_SET_INJECTION_TARGETS,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          McpInjectionTargetsPayloadSchema,
          payload,
          'MCP_ORCHESTRATOR_SET_INJECTION_TARGETS',
        );
        getCliMcpConfigService().orchestratorSetInjectionTargets(validated.serverId, validated.providers);
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_ORCHESTRATOR_SET_INJECTION_TARGETS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_SHARED_UPSERT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(SharedMcpServerUpsertSchema, payload, 'MCP_SHARED_UPSERT');
        const id = getCliMcpConfigService().sharedUpsert(validated);
        await broadcastMultiProviderState();
        return { success: true, data: { id } };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SHARED_UPSERT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_SHARED_DELETE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpDeletePayloadSchema, payload, 'MCP_SHARED_DELETE');
        getCliMcpConfigService().sharedDelete(validated.serverId);
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SHARED_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_SHARED_FAN_OUT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpFanOutPayloadSchema, payload, 'MCP_SHARED_FAN_OUT');
        const result = await getSharedMcpCoordinator().fanOut(validated.serverId, validated.providers);
        await getCliMcpConfigService().refreshMultiProviderState();
        await broadcastMultiProviderState();
        return { success: true, data: result };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SHARED_FAN_OUT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_SHARED_GET_DRIFT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpDriftQuerySchema, payload, 'MCP_SHARED_GET_DRIFT');
        return {
          success: true,
          data: await getSharedMcpCoordinator().getDrift(validated.serverId),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SHARED_GET_DRIFT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_SHARED_RESOLVE_DRIFT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(McpResolveDriftPayloadSchema, payload, 'MCP_SHARED_RESOLVE_DRIFT');
        await getSharedMcpCoordinator().resolveDrift(
          validated.serverId,
          validated.provider,
          validated.action,
        );
        await getCliMcpConfigService().refreshMultiProviderState();
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_SHARED_RESOLVE_DRIFT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_PROVIDER_USER_UPSERT,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          McpProviderUserUpsertPayloadSchema,
          payload,
          'MCP_PROVIDER_USER_UPSERT',
        );
        await getCliMcpConfigService().providerUserUpsert({
          id: validated.id ?? `${validated.provider}:user:${validated.name}`,
          provider: validated.provider,
          name: validated.name,
          description: validated.description,
          transport: validated.transport,
          command: validated.command,
          args: validated.args,
          url: validated.url,
          headers: validated.headers,
          env: validated.env,
          autoConnect: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_PROVIDER_USER_UPSERT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_PROVIDER_USER_DELETE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          McpProviderUserDeletePayloadSchema,
          payload,
          'MCP_PROVIDER_USER_DELETE',
        );
        await getCliMcpConfigService().providerUserDelete(validated.provider, validated.serverId);
        await broadcastMultiProviderState();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_PROVIDER_USER_DELETE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_PROVIDER_OPEN_SCOPE_FILE,
    async (_event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          McpProviderScopePayloadSchema,
          payload,
          'MCP_PROVIDER_OPEN_SCOPE_FILE',
        );
        return {
          success: true,
          data: await getCliMcpConfigService().providerOpenScopeFile(
            validated.provider,
            validated.scope,
          ),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MCP_PROVIDER_OPEN_SCOPE_FILE_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}

function toMcpManagerConfig(record: OrchestratorMcpServer): McpServerConfig {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    source: 'orchestrator',
    sourceProvider: 'orchestrator',
    scope: record.scope,
    transport: record.transport,
    command: record.command,
    args: record.args,
    env: record.env,
    url: record.url,
    headers: record.headers,
    autoConnect: record.autoConnect,
  };
}
