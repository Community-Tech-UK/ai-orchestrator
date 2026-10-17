/**
 * Command Store - State management for commands
 * Includes built-in commands and skills from the skill registry
 */

import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommandIpcService } from '../services/ipc';
import { IpcEventBusService } from '../services/ipc/ipc-event-bus.service';
import { SkillStore } from './skill.store';
import { InstanceStore } from './instance.store';
import { evaluateApplicability } from '../../../../shared/utils/command-applicability';
import type {
  CommandDiagnostic,
  CommandRegistrySnapshot,
  CommandResolutionResult,
  CommandTemplate,
} from '../../../../shared/types/command.types';
import type { IpcResponse } from '../services/ipc/electron-ipc.service';

// Extended command type that includes skill commands
export interface ExtendedCommand extends CommandTemplate {
  isSkill?: boolean;
  skillId?: string;
  trigger?: string;
}

const UNAVAILABLE_NATIVE_STATUSES = new Set([
  'initializing', 'respawning', 'hibernating', 'hibernated', 'waking',
  'terminated', 'failed', 'error', 'cancelled', 'superseded',
]);

@Injectable({ providedIn: 'root' })
export class CommandStore {
  private ipcService = inject(CommandIpcService);
  private skillStore = inject(SkillStore);
  private instanceStore = inject(InstanceStore);
  private eventBus = inject(IpcEventBusService);
  private destroyRef = inject(DestroyRef);

  // State
  private _commands = signal<CommandTemplate[]>([]);
  private _diagnostics = signal<CommandDiagnostic[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);
  private _searchQuery = signal('');
  private lastLoadedWorkingDirectory: string | null = null;
  private lastLoadedContextKey: string | null = null;
  private catalogContextKey = signal<string | null>(null);
  private loadSequence = 0;
  private skillsLoaded = false;
  private lastNativeSessionKey = '';

  // Selectors - raw commands without skills
  rawCommands = computed(() => {
    const selected = this.instanceStore.selectedInstance();
    const ownsNativeCatalog = selected?.provider === 'opencode'
      && !UNAVAILABLE_NATIVE_STATUSES.has(selected.status)
      && this.catalogContextKey() === this.selectedContextKey();
    return ownsNativeCatalog ? this._commands()
      : this._commands().filter(command => !command.id.startsWith('acp:opencode:'));
  });
  diagnostics = this._diagnostics.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();
  searchQuery = this._searchQuery.asReadonly();

  /**
   * Combined commands: built-in commands + skill triggers
   */
  commands = computed((): ExtendedCommand[] => {
    const cmds = this.rawCommands();
    const skillCmds = this.skillStore.skillCommands();

    // Convert skill commands to CommandTemplate format
    const skillsAsCommands: ExtendedCommand[] = skillCmds.map(skill => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      template: '', // Skills don't use templates - they're handled differently
      hint: `Skill: ${skill.category || 'General'}`,
      aliases: skill.trigger ? [skill.trigger] : undefined,
      category: 'skill',
      usage: skill.trigger ? `/${skill.trigger}` : `/${skill.name}`,
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
    this.rawCommands().filter(cmd => cmd.builtIn)
  );

  customCommands = computed(() =>
    this.rawCommands().filter(cmd => !cmd.builtIn)
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
      cmd.description.toLowerCase().includes(query) ||
      (cmd.aliases ?? []).some((alias) => alias.toLowerCase().includes(query)) ||
      cmd.category?.toLowerCase().includes(query)
    );
  });

  /**
   * Load all commands from main process (including skills)
   */
  constructor() {
    this.eventBus.instanceStateUpdate$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(update => {
      const selected = this.instanceStore.selectedInstance();
      if (update.commandsChanged !== true || selected?.provider !== 'opencode' || selected.id !== update.instanceId) return;
      this.lastLoadedContextKey = null;
      this.catalogContextKey.set(null);
      void this.loadCommands(undefined, true);
    });
    effect(() => {
      const selected = this.instanceStore.selectedInstance();
      const workingDirectory = selected?.workingDirectory ?? null;
      const nativeKey = selected?.provider === 'opencode'
        ? JSON.stringify([this.selectedContextKey(), selected.status]) : '';
      const refresh = nativeKey !== this.lastNativeSessionKey;
      this.lastNativeSessionKey = nativeKey;
      if (nativeKey && !refresh) return;
      untracked(() => { void this.loadCommands(workingDirectory, refresh); });
    });
  }

  private selectedContextKey(): string {
    const selected = this.instanceStore.selectedInstance();
    return JSON.stringify([selected?.id, selected?.provider, selected?.workingDirectory,
      ...(selected?.provider === 'opencode'
        ? [selected.restartEpoch, selected.adapterGeneration, selected.providerSessionId] : [])]);
  }

  async loadCommands(
    workingDirectory: string | null = this.instanceStore.selectedInstance()?.workingDirectory ?? null,
    force = false,
  ): Promise<void> {
    const normalizedWorkingDirectory = workingDirectory ?? null;
    const contextKey = this.selectedContextKey();
    if (
      !force && this.lastLoadedWorkingDirectory === normalizedWorkingDirectory &&
      this.lastLoadedContextKey === contextKey &&
      this._commands().length > 0
    ) {
      return;
    }

    const requestId = ++this.loadSequence;
    const isCurrent = () => !this.destroyRef.destroyed && requestId === this.loadSequence
      && contextKey === this.selectedContextKey();
    this._loading.set(true);
    this._error.set(null);

    try {
      const pendingWork: [Promise<IpcResponse>, Promise<unknown>] = [
        this.ipcService.listCommands(normalizedWorkingDirectory ?? undefined, this.instanceStore.selectedInstance()?.id),
        this.skillsLoaded ? Promise.resolve() : this.skillStore.discoverSkills(),
      ];
      const [commandResponse] = await Promise.all(pendingWork);

      if (!isCurrent()) {
        return;
      }

      if (commandResponse.success && 'data' in commandResponse && commandResponse.data) {
        const data = commandResponse.data as CommandTemplate[] | CommandRegistrySnapshot;
        if (Array.isArray(data)) {
          this._commands.set(data);
          this._diagnostics.set([]);
        } else {
          this._commands.set(data.commands);
          this._diagnostics.set(data.diagnostics);
        }
        this.lastLoadedWorkingDirectory = normalizedWorkingDirectory;
        this.lastLoadedContextKey = contextKey;
        this.catalogContextKey.set(contextKey);
        this.skillsLoaded = true;
      } else {
        const errorMsg = 'error' in commandResponse ? commandResponse.error?.message : 'Failed to load commands';
        this._error.set(errorMsg || 'Failed to load commands');
      }
    } catch (err) {
      if (isCurrent()) this._error.set((err as Error).message);
    } finally {
      if (isCurrent()) this._loading.set(false);
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

  async resolveCommand(
    input: string,
    workingDirectory = this.instanceStore.selectedInstance()?.workingDirectory,
  ): Promise<CommandResolutionResult | null> {
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input);
    const native = match ? this.rawCommands().find((command) => command.id.startsWith('acp:opencode:') && command.name === match[1]) : undefined;
    if (native) return { kind: 'exact', command: native, args: match?.[2] ? [match[2]] : [], matchedBy: 'name' };
    const response = await this.ipcService.resolveCommand(input, workingDirectory);
    if (!response.success || !response.data) return null;
    return response.data as CommandResolutionResult;
  }

  commandEligibility(command: CommandTemplate): { eligible: boolean; reason?: string } {
    const selected = this.instanceStore.selectedInstance();
    return evaluateApplicability(command, {
      provider: selected?.provider === 'ollama' ? undefined : selected?.provider,
      instanceStatus: selected?.status,
      workingDirectory: selected?.workingDirectory,
    });
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
    const query = name.toLowerCase();
    return this.rawCommands().find(cmd =>
      cmd.name.toLowerCase() === query ||
      (cmd.aliases ?? []).some((alias) => alias.toLowerCase() === query)
    );
  }
}
