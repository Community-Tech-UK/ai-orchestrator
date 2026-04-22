/**
 * Command Manager - Manages custom user-defined commands
 */

import ElectronStore from 'electron-store';
import { generateId } from '../../shared/utils/id-generator';
import {
  CommandTemplate,
  ParsedCommand,
  BUILT_IN_COMMANDS,
  getCommandExecution,
  getMarkdownCommandNameFromId,
  isMarkdownCommandId,
  resolveTemplate,
  parseCommandString,
} from '../../shared/types/command.types';
import { getMarkdownCommandRegistry } from './markdown-command-registry';

interface CommandStoreSchema {
  customCommands: CommandTemplate[];
}

// Type for the internal store with the methods we need
interface Store<T> {
  store: T;
  get<K extends keyof T>(key: K): T[K];
  set<K extends keyof T>(key: K, value: T[K]): void;
}

// Cast to our Store interface to work around ESM type resolution issues
const store = new ElectronStore<CommandStoreSchema>({
  name: 'commands',
  defaults: {
    customCommands: [],
  },
}) as unknown as Store<CommandStoreSchema>;

class CommandManager {
  private builtInCommands: Map<string, CommandTemplate> = new Map();

  constructor() {
    this.initializeBuiltInCommands();
  }

  /**
   * Initialize built-in commands
   */
  private initializeBuiltInCommands(): void {
    const now = Date.now();
    for (const cmd of BUILT_IN_COMMANDS) {
      const command: CommandTemplate = {
        ...cmd,
        id: `builtin-${cmd.name}`,
        createdAt: now,
        updatedAt: now,
        source: 'builtin',
      };
      this.builtInCommands.set(command.id, command);
    }
  }

  /**
   * Get all commands (built-in + custom)
   */
  private getLocalCommands(): CommandTemplate[] {
    const builtIn = Array.from(this.builtInCommands.values());
    const custom = store.get('customCommands').map((c) => ({ ...c, source: 'store' as const }));
    return [...builtIn, ...custom];
  }

  /**
   * Get command by ID
   */
  private getLocalCommand(commandId: string): CommandTemplate | undefined {
    // Check built-in first
    if (this.builtInCommands.has(commandId)) {
      return this.builtInCommands.get(commandId);
    }
    // Check custom commands
    const custom = store.get('customCommands');
    return custom.find((c) => c.id === commandId);
  }

  /**
   * Get command by name
   */
  private getLocalCommandByName(name: string): CommandTemplate | undefined {
    // Check built-in first
    for (const cmd of this.builtInCommands.values()) {
      if (cmd.name === name) return cmd;
    }
    // Check custom commands
    const custom = store.get('customCommands');
    return custom.find((c) => c.name === name);
  }

  /**
   * Get all commands visible for a working directory.
   * Local built-in/stored commands keep precedence over markdown commands with the same name.
   */
  async getAllCommands(workingDirectory?: string): Promise<CommandTemplate[]> {
    const localCommands = this.getLocalCommands();
    if (!workingDirectory) {
      return localCommands;
    }

    const markdownCommands = (await getMarkdownCommandRegistry().listCommands(workingDirectory)).commands;
    const localNames = new Set(localCommands.map((command) => command.name));
    return [
      ...localCommands,
      ...markdownCommands.filter((command) => !localNames.has(command.name)),
    ];
  }

  /**
   * Get command by ID, including markdown commands scoped to a working directory.
   */
  async getCommand(commandId: string, workingDirectory?: string): Promise<CommandTemplate | undefined> {
    const localCommand = this.getLocalCommand(commandId);
    if (localCommand) {
      return localCommand;
    }

    if (!workingDirectory || !isMarkdownCommandId(commandId)) {
      return undefined;
    }

    const name = getMarkdownCommandNameFromId(commandId);
    if (!name) {
      return undefined;
    }

    return getMarkdownCommandRegistry().getCommand(workingDirectory, name);
  }

  /**
   * Get command by name, including markdown commands scoped to a working directory.
   */
  async getCommandByName(name: string, workingDirectory?: string): Promise<CommandTemplate | undefined> {
    const localCommand = this.getLocalCommandByName(name);
    if (localCommand) {
      return localCommand;
    }

    if (!workingDirectory) {
      return undefined;
    }

    return getMarkdownCommandRegistry().getCommand(workingDirectory, name);
  }

  /**
   * Execute a command with arguments
   */
  async executeCommand(
    commandId: string,
    args: string[],
    workingDirectory?: string,
  ): Promise<ParsedCommand | null> {
    const command = await this.getCommand(commandId, workingDirectory);
    if (!command) return null;

    return {
      command,
      args,
      resolvedPrompt: resolveTemplate(command.template, args),
      execution: getCommandExecution(command),
    };
  }

  /**
   * Execute a command from a command string (e.g., "/review focus on errors")
   */
  async executeCommandString(input: string, workingDirectory?: string): Promise<ParsedCommand | null> {
    const parsed = parseCommandString(input);
    if (!parsed) return null;

    const command = await this.getCommandByName(parsed.name, workingDirectory);
    if (!command) return null;

    return {
      command,
      args: parsed.args,
      resolvedPrompt: resolveTemplate(command.template, parsed.args),
      execution: getCommandExecution(command),
    };
  }

  /**
   * Create a custom command
   */
  createCommand(config: {
    name: string;
    description: string;
    template: string;
    hint?: string;
    shortcut?: string;
  }): CommandTemplate {
    // Check for duplicate name
    if (this.getLocalCommandByName(config.name)) {
      throw new Error(`Command with name "${config.name}" already exists`);
    }

    const now = Date.now();
    const command: CommandTemplate = {
      id: generateId(),
      name: config.name,
      description: config.description,
      template: config.template,
      hint: config.hint,
      shortcut: config.shortcut,
      builtIn: false,
      createdAt: now,
      updatedAt: now,
      source: 'store',
    };

    const custom = store.get('customCommands');
    custom.push(command);
    store.set('customCommands', custom);

    return command;
  }

  /**
   * Update a custom command
   */
  updateCommand(
    commandId: string,
    updates: Partial<{
      name: string;
      description: string;
      template: string;
      hint: string;
      shortcut: string;
    }>
  ): CommandTemplate | null {
    // Cannot update built-in commands
    if (this.builtInCommands.has(commandId)) {
      return null;
    }

    const custom = store.get('customCommands');
    const index = custom.findIndex((c) => c.id === commandId);
    if (index === -1) return null;

    // Check for duplicate name if name is being changed
    if (updates.name && updates.name !== custom[index].name) {
      if (this.getLocalCommandByName(updates.name)) {
        throw new Error(`Command with name "${updates.name}" already exists`);
      }
    }

    const updated: CommandTemplate = {
      ...custom[index],
      ...updates,
      updatedAt: Date.now(),
    };

    custom[index] = updated;
    store.set('customCommands', custom);

    return updated;
  }

  /**
   * Delete a custom command
   */
  deleteCommand(commandId: string): boolean {
    // Cannot delete built-in commands
    if (this.builtInCommands.has(commandId)) {
      return false;
    }

    const custom = store.get('customCommands');
    const filtered = custom.filter((c) => c.id !== commandId);

    if (filtered.length === custom.length) {
      return false; // Not found
    }

    store.set('customCommands', filtered);
    return true;
  }

  /**
   * Reset custom commands (delete all)
   */
  resetCustomCommands(): void {
    store.set('customCommands', []);
  }
}

// Singleton instance
let commandManagerInstance: CommandManager | null = null;

export function getCommandManager(): CommandManager {
  if (!commandManagerInstance) {
    commandManagerInstance = new CommandManager();
  }
  return commandManagerInstance;
}

export { CommandManager };
