/**
 * Command Manager - Manages custom user-defined commands
 */

import ElectronStore from 'electron-store';
import { generateId } from '../../shared/utils/id-generator';
import {
  CommandTemplate,
  ParsedCommand,
  BUILT_IN_COMMANDS,
  resolveTemplate,
  parseCommandString,
} from '../../shared/types/command.types';

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
      };
      this.builtInCommands.set(command.id, command);
    }
  }

  /**
   * Get all commands (built-in + custom)
   */
  getAllCommands(): CommandTemplate[] {
    const builtIn = Array.from(this.builtInCommands.values());
    const custom = store.get('customCommands');
    return [...builtIn, ...custom];
  }

  /**
   * Get command by ID
   */
  getCommand(commandId: string): CommandTemplate | undefined {
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
  getCommandByName(name: string): CommandTemplate | undefined {
    // Check built-in first
    for (const cmd of this.builtInCommands.values()) {
      if (cmd.name === name) return cmd;
    }
    // Check custom commands
    const custom = store.get('customCommands');
    return custom.find((c) => c.name === name);
  }

  /**
   * Execute a command with arguments
   */
  executeCommand(commandId: string, args: string[]): ParsedCommand | null {
    const command = this.getCommand(commandId);
    if (!command) return null;

    return {
      command,
      args,
      resolvedPrompt: resolveTemplate(command.template, args),
    };
  }

  /**
   * Execute a command from a command string (e.g., "/review focus on errors")
   */
  executeCommandString(input: string): ParsedCommand | null {
    const parsed = parseCommandString(input);
    if (!parsed) return null;

    const command = this.getCommandByName(parsed.name);
    if (!command) return null;

    return {
      command,
      args: parsed.args,
      resolvedPrompt: resolveTemplate(command.template, parsed.args),
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
    if (this.getCommandByName(config.name)) {
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
      if (this.getCommandByName(updates.name)) {
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
