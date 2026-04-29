/**
 * Command Manager - Manages custom user-defined commands
 */

import ElectronStore from 'electron-store';
import { generateId } from '../../shared/utils/id-generator';
import {
  CommandTemplate,
  ParsedCommand,
  BUILT_IN_COMMANDS,
  CommandDiagnostic,
  CommandRegistrySnapshot,
  CommandResolutionResult,
  getCommandExecution,
  getMarkdownCommandNameFromId,
  isMarkdownCommandId,
  resolveTemplate,
  parseCommandString,
} from '../../shared/types/command.types';
import { parseArgsFromQuery } from '../../shared/utils/command-args';
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
    return (await this.getAllCommandsSnapshot(workingDirectory)).commands;
  }

  async getAllCommandsSnapshot(workingDirectory?: string): Promise<CommandRegistrySnapshot> {
    const localCommands = this.getLocalCommands();
    const localDiagnostics = this.computeCollisionDiagnostics(localCommands);
    if (!workingDirectory) {
      return {
        commands: localCommands,
        diagnostics: localDiagnostics,
        scanDirs: [],
      };
    }

    const markdownSnapshot = await getMarkdownCommandRegistry().listCommands(workingDirectory);
    const localNames = new Set(localCommands.map((command) => command.name.toLowerCase()));
    const commands = [
      ...localCommands,
      ...markdownSnapshot.commands.filter((command) => !localNames.has(command.name.toLowerCase())),
    ];

    return {
      commands,
      diagnostics: [
        ...localDiagnostics,
        ...markdownSnapshot.diagnostics,
        ...this.computeCollisionDiagnostics(commands),
      ],
      scanDirs: markdownSnapshot.scanDirs,
    };
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

  async resolveCommand(input: string, workingDirectory?: string): Promise<CommandResolutionResult> {
    const parsed = parseCommandString(input);
    const query = parsed?.name || input.replace(/^\//, '').trim().split(/\s+/)[0] || '';
    if (!query) {
      return { kind: 'none', query };
    }

    const direct = await this.getCommandByName(query, workingDirectory);
    if (direct) {
      return {
        kind: 'exact',
        command: direct,
        args: parseArgsFromQuery(input, query),
        matchedBy: 'name',
      };
    }

    const snapshot = await this.getAllCommandsSnapshot(workingDirectory);
    const commands = snapshot.commands;
    const lowerQuery = query.toLowerCase();

    const exact = commands.filter((command) => command.name.toLowerCase() === lowerQuery);
    if (exact.length === 1) {
      return {
        kind: 'exact',
        command: exact[0],
        args: parseArgsFromQuery(input, query),
        matchedBy: 'name',
      };
    }
    if (exact.length > 1) {
      return { kind: 'ambiguous', query, candidates: exact };
    }

    const aliasMatches = commands.filter((command) =>
      (command.aliases ?? []).some((alias) => alias.toLowerCase() === lowerQuery),
    );
    const uniqueAliasMatches = [...new Map(aliasMatches.map((command) => [command.id, command])).values()];
    if (uniqueAliasMatches.length === 1) {
      return {
        kind: 'alias',
        command: uniqueAliasMatches[0],
        args: parseArgsFromQuery(input, query),
        matchedBy: 'alias',
        alias: query,
      };
    }
    if (uniqueAliasMatches.length > 1) {
      return {
        kind: 'ambiguous',
        query,
        conflictingAlias: query,
        candidates: uniqueAliasMatches,
      };
    }

    const suggestions = fuzzySuggestions(query, commands);
    if (suggestions.length > 0) {
      return { kind: 'fuzzy', query, suggestions };
    }

    return { kind: 'none', query };
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
    const resolved = await this.resolveCommand(input, workingDirectory);
    if (resolved.kind !== 'exact' && resolved.kind !== 'alias') return null;

    return {
      command: resolved.command,
      args: resolved.args,
      resolvedPrompt: resolveTemplate(resolved.command.template, resolved.args),
      execution: getCommandExecution(resolved.command),
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

  private computeCollisionDiagnostics(commands: CommandTemplate[]): CommandDiagnostic[] {
    const diagnostics: CommandDiagnostic[] = [];
    const names = new Map<string, CommandTemplate[]>();
    const aliases = new Map<string, CommandTemplate[]>();

    for (const command of commands) {
      const nameKey = command.name.toLowerCase();
      const nameList = names.get(nameKey) ?? [];
      nameList.push(command);
      names.set(nameKey, nameList);

      for (const alias of command.aliases ?? []) {
        const aliasKey = alias.toLowerCase();
        const aliasList = aliases.get(aliasKey) ?? [];
        aliasList.push(command);
        aliases.set(aliasKey, aliasList);
      }
    }

    for (const [name, owners] of names.entries()) {
      if (owners.length > 1) {
        diagnostics.push({
          code: 'name-collision',
          severity: 'warn',
          message: `Multiple commands define "/${name}"; the first visible command wins.`,
          candidates: owners.map((owner) => owner.id),
        });
      }
    }

    for (const [alias, owners] of aliases.entries()) {
      const uniqueOwners = [...new Map(owners.map((owner) => [owner.id, owner])).values()];
      const nameOwners = names.get(alias) ?? [];
      const shadowingOwners = nameOwners.filter((owner) =>
        uniqueOwners.every((aliasOwner) => aliasOwner.id !== owner.id),
      );
      if (shadowingOwners.length > 0) {
        diagnostics.push({
          code: 'alias-shadowed-by-name',
          severity: 'warn',
          alias,
          message: `Alias "${alias}" is shadowed by command "/${shadowingOwners[0].name}"`,
          candidates: [...shadowingOwners, ...uniqueOwners].map((owner) => owner.id),
        });
      }
      if (uniqueOwners.length > 1) {
        diagnostics.push({
          code: 'alias-collision',
          severity: 'warn',
          alias,
          message: `Alias "${alias}" is defined by multiple commands`,
          candidates: uniqueOwners.map((owner) => owner.id),
        });
      }
    }

    return diagnostics;
  }
}

function fuzzySuggestions(query: string, commands: CommandTemplate[]): CommandTemplate[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .map((command) => {
      const name = command.name.toLowerCase();
      const aliases = (command.aliases ?? []).map((alias) => alias.toLowerCase());
      const tokens = [name, ...aliases];
      const distance = Math.min(...tokens.map((token) => damerauLevenshtein(normalizedQuery, token)));
      const prefix = tokens.some((token) => token.startsWith(normalizedQuery)) ? 1 : 0;
      return { command, distance, prefix };
    })
    .filter((item) => item.prefix === 1 || item.distance <= 2)
    .sort((a, b) => b.prefix - a.prefix || a.distance - b.distance || a.command.name.localeCompare(b.command.name))
    .slice(0, 5)
    .map((item) => item.command);
}

function damerauLevenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }

  return matrix[a.length][b.length];
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
