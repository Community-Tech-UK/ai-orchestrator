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
import { MCP_SERVER_PRESETS } from '../../../shared/types/mcp.types';
import { WindowManager } from '../../window-manager';
import { getBrowserAutomationHealthService } from '../../browser-automation/browser-automation-health';
import {
  discoverProviderMcpServers,
  setProviderMcpServerEnabled,
} from '../../mcp/provider-mcp-config-discovery';

export function registerMcpHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const mcp = getMcpManager();
  const lifecycle = getMcpLifecycleManager();

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
        mcp.addServer({
          id: validated.id,
          name: validated.name,
          description: validated.description,
          transport: validated.transport,
          command: validated.command,
          args: validated.args,
          env: validated.env,
          url: validated.url,
          autoConnect: validated.autoConnect
        });
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
}
