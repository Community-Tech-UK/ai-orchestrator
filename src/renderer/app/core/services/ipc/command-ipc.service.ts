/**
 * Command IPC Service - Command and bash operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class CommandIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // Command Operations
  // ============================================

  /**
   * List all commands (built-in + custom)
   */
  async listCommands(workingDirectory?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.listCommands({ workingDirectory });
  }

  /**
   * Execute a command
   */
  async executeCommand(commandId: string, instanceId: string, args?: string[]): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.executeCommand({ commandId, instanceId, args });
  }

  /**
   * Create a custom command
   */
  async createCommand(config: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.createCommand(config);
  }

  /**
   * Update a custom command
   */
  async updateCommand(commandId: string, updates: Partial<{
    name: string;
    description: string;
    template: string;
    hint: string;
  }>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updateCommand({ commandId, updates });
  }

  /**
   * Delete a custom command
   */
  async deleteCommand(commandId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.deleteCommand(commandId);
  }

  // ============================================
  // Bash Validation
  // ============================================

  /**
   * Validate a bash command for safety
   * Returns risk level and any warnings/blocks
   */
  async bashValidate(command: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashValidate(command);
  }

  /**
   * Get bash validator configuration
   */
  async bashGetConfig(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashGetConfig();
  }

  /**
   * Add a command to the allowed list
   */
  async bashAddAllowed(command: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashAddAllowed(command);
  }

  /**
   * Add a command to the blocked list
   */
  async bashAddBlocked(command: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.bashAddBlocked(command);
  }
}
