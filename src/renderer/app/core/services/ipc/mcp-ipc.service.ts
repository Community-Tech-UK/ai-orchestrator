/**
 * MCP IPC Service - MCP server operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class McpIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // MCP Operations
  // ============================================

  /**
   * Get full MCP state (servers, tools, resources, prompts)
   */
  async mcpGetState(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetState();
  }

  /**
   * Get all MCP servers
   */
  async mcpGetServers(options?: { includeExternal?: boolean }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetServers(options);
  }

  /**
   * Enable or disable a provider-configured MCP server
   */
  async mcpSetServerEnabled(serverId: string, enabled: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpSetServerEnabled({ serverId, enabled });
  }

  /**
   * Add an MCP server
   */
  async mcpAddServer(payload: {
    id: string;
    name: string;
    description?: string;
    transport: 'stdio' | 'http' | 'sse';
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    autoConnect?: boolean;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpAddServer(payload);
  }

  /**
   * Remove an MCP server
   */
  async mcpRemoveServer(serverId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpRemoveServer(serverId);
  }

  /**
   * Connect to an MCP server
   */
  async mcpConnect(serverId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpConnect(serverId);
  }

  /**
   * Disconnect from an MCP server
   */
  async mcpDisconnect(serverId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpDisconnect(serverId);
  }

  /**
   * Restart an MCP server connection
   */
  async mcpRestart(serverId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpRestart(serverId);
  }

  /**
   * Get all MCP tools
   */
  async mcpGetTools(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetTools();
  }

  /**
   * Get all MCP resources
   */
  async mcpGetResources(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetResources();
  }

  /**
   * Get all MCP prompts
   */
  async mcpGetPrompts(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPrompts();
  }

  /**
   * Call an MCP tool
   */
  async mcpCallTool(payload: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpCallTool(payload);
  }

  /**
   * Read an MCP resource
   */
  async mcpReadResource(payload: {
    serverId: string;
    uri: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpReadResource(payload);
  }

  /**
   * Get an MCP prompt
   */
  async mcpGetPrompt(payload: {
    serverId: string;
    promptName: string;
    arguments?: Record<string, string>;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPrompt(payload);
  }

  /**
   * Get MCP server presets
   */
  async mcpGetPresets(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.mcpGetPresets();
  }

  /**
   * Subscribe to MCP state changes (tools, resources, prompts updated)
   */
  onMcpStateChanged(callback: (data: { type: string; serverId?: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };

    return this.api.onMcpStateChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Subscribe to MCP server status changes
   */
  onMcpServerStatusChanged(callback: (data: { serverId: string; status: string; error?: string }) => void): () => void {
    if (!this.api) return () => { /* noop */ };

    return this.api.onMcpServerStatusChanged((data) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
