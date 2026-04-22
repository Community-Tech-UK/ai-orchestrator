/**
 * Command Store - State management for commands
 * Includes built-in commands and skills from the skill registry
 */

import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { CommandIpcService } from '../services/ipc';
import { SkillStore } from './skill.store';
import { InstanceStore } from './instance.store';
import type { CommandTemplate } from '../../../../shared/types/command.types';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';

// Extended command type that includes skill commands
export interface ExtendedCommand extends CommandTemplate {
  isSkill?: boolean;
  skillId?: string;
  trigger?: string;
}

@Injectable({ providedIn: 'root' })
export class CommandStore {
  private ipcService = inject(CommandIpcService);
  private skillStore = inject(SkillStore);
  private instanceStore = inject(InstanceStore);

  // State
  private _commands = signal<CommandTemplate[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _searchQuery = signal('');
  private lastLoadedWorkingDirectory: string | null = null;
  private loadSequence = 0;
  private skillsLoaded = false;

  // Selectors - raw commands without skills
  rawCommands = this._commands.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();
  searchQuery = this._searchQuery.asReadonly();

  /**
   * Combined commands: built-in commands + skill triggers
   */
  commands = computed((): ExtendedCommand[] => {
    const cmds = this._commands();
    const skillCmds = this.skillStore.skillCommands();

    // Convert skill commands to CommandTemplate format
    const skillsAsCommands: ExtendedCommand[] = skillCmds.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      template: '', // Skills don't use templates - they're handled differently
      hint: `Skill: ${skill.category || 'General'}`,
      builtIn: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      isSkill: true,
      skillId: skill.id.split(':')[1], // Extract skill ID from "skill:id:trigger"
      trigger: skill.trigger,
    }));

    return [...cmds, ...skillsAsCommands];
  });

  builtInCommands = computed(() =>
    this._commands().filter(cmd => cmd.builtIn)
  );

  customCommands = computed(() =>
    this._commands().filter(cmd => !cmd.builtIn)
  );

  skillCommands = computed(() =>
    this.commands().filter((cmd): cmd is ExtendedCommand & { isSkill: true } => cmd.isSkill === true)
  );

  filteredCommands = computed(() => {
    const query = this._searchQuery().toLowerCase().trim();
    const allCommands = this.commands();
    if (!query) return allCommands;

    return allCommands.filter(cmd =>
      cmd.name.toLowerCase().includes(query) ||
      cmd.description.toLowerCase().includes(query)
    );
  });

  /**
   * Load all commands from main process (including skills)
   */
  constructor() {
    effect(() => {
      const workingDirectory = this.instanceStore.selectedInstance()?.workingDirectory ?? null;
      void this.loadCommands(workingDirectory);
    });
  }

  async loadCommands(
    workingDirectory: string | null = this.instanceStore.selectedInstance()?.workingDirectory ?? null,
  ): Promise<void> {
    const normalizedWorkingDirectory = workingDirectory ?? null;
    if (
      this.lastLoadedWorkingDirectory === normalizedWorkingDirectory &&
      this._commands().length > 0
    ) {
      return;
    }

    const requestId = ++this.loadSequence;
    this._loading.set(true);
    this._error.set(null);

    try {
      const pendingWork: [Promise<IpcResponse>, Promise<unknown>] = [
        this.ipcService.listCommands(normalizedWorkingDirectory ?? undefined),
        this.skillsLoaded ? Promise.resolve() : this.skillStore.discoverSkills(),
      ];
      const [commandResponse] = await Promise.all(pendingWork);

      if (requestId !== this.loadSequence) {
        return;
      }

      if (commandResponse.success && 'data' in commandResponse && commandResponse.data) {
        this._commands.set(commandResponse.data as CommandTemplate[]);
        this.lastLoadedWorkingDirectory = normalizedWorkingDirectory;
        this.skillsLoaded = true;
      } else {
        const errorMsg = 'error' in commandResponse ? commandResponse.error?.message : 'Failed to load commands';
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
