/**
 * Command Store - State management for commands
 */

import { Injectable, inject, signal, computed } from '@angular/core';
import { ElectronIpcService } from '../services/electron-ipc.service';
import type { CommandTemplate } from '../../../../shared/types/command.types';

@Injectable({ providedIn: 'root' })
export class CommandStore {
  private ipcService = inject(ElectronIpcService);

  // State
  private _commands = signal<CommandTemplate[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _searchQuery = signal('');

  // Selectors
  commands = this._commands.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();
  searchQuery = this._searchQuery.asReadonly();

  builtInCommands = computed(() =>
    this._commands().filter(cmd => cmd.builtIn)
  );

  customCommands = computed(() =>
    this._commands().filter(cmd => !cmd.builtIn)
  );

  filteredCommands = computed(() => {
    const query = this._searchQuery().toLowerCase().trim();
    if (!query) return this._commands();

    return this._commands().filter(cmd =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    );
  });

  /**
   * Load all commands from main process
   */
  async loadCommands(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);

    try {
      const response = await this.ipcService.listCommands();
      if (response.success && 'data' in response && response.data) {
        this._commands.set(response.data as CommandTemplate[]);
      } else {
        const errorMsg = 'error' in response ? response.error?.message : 'Failed to load commands';
        this._error.set(errorMsg || 'Failed to load commands');
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Set search query for filtering
   */
  setSearchQuery(query: string): void {
    this._searchQuery.set(query);
  }

  /**
   * Execute a command
   */
  async executeCommand(
    commandId: string,
    instanceId: string,
    args?: string[]
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.ipcService.executeCommand(commandId, instanceId, args);
      if (!response.success) {
        return { success: false, error: response.error?.message };
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Create a custom command
   */
  async createCommand(config: {
    name: string;
    description: string;
    template: string;
    hint?: string;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.ipcService.createCommand(config);
      if (response.success) {
        await this.loadCommands();
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Update a custom command
   */
  async updateCommand(
    commandId: string,
    updates: Partial<{
      name: string;
      description: string;
      template: string;
      hint: string;
    }>
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.ipcService.updateCommand(commandId, updates);
      if (response.success) {
        await this.loadCommands();
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Delete a custom command
   */
  async deleteCommand(commandId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await this.ipcService.deleteCommand(commandId);
      if (response.success) {
        await this.loadCommands();
        return { success: true };
      }
      return { success: false, error: response.error?.message };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get a command by name
   */
  getCommandByName(name: string): CommandTemplate | undefined {
    return this._commands().find(cmd => cmd.name === name);
  }
}
