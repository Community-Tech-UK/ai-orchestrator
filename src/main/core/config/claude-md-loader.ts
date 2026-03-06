/**
 * Instruction Markdown Config Loader (legacy class name preserved for compatibility)
 *
 * Load and parse instruction configuration files from:
 * - User-level: ~/.orchestrator/INSTRUCTIONS.md (preferred), ~/.claude/CLAUDE.md (legacy)
 * - Project-level: ./.orchestrator/INSTRUCTIONS.md (preferred), ./.claude/CLAUDE.md (legacy), ./CLAUDE.md (legacy)
 * - Custom paths from settings
 *
 * Supports:
 * - Memory bank paths
 * - Custom instructions
 * - Tool permissions
 * - Allowed/denied commands
 * - Environment variables
 */

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as yaml from 'js-yaml';
import type {
  InstructionResolution,
  InstructionSourceKind,
  InstructionSourceScope,
} from '../../../shared/types/instruction-source.types';
import { resolveInstructionStack } from './instruction-resolver';

export interface ClaudeConfig {
  /** Custom instructions prepended to system prompt */
  instructions?: string;
  /** Memory bank configuration */
  memory?: MemoryConfig;
  /** Tool permissions */
  tools?: ToolPermissions;
  /** Command restrictions */
  commands?: CommandConfig;
  /** Environment variables */
  env?: Record<string, string>;
  /** MCP server configurations */
  mcpServers?: MCPServerConfig[];
  /** Skill preferences */
  skills?: SkillConfig;
  /** Model preferences */
  model?: ModelConfig;
  /** Context management */
  context?: ContextConfig;
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

export interface MemoryConfig {
  /** Enable memory bank */
  enabled: boolean;
  /** Memory file paths */
  paths?: string[];
  /** Auto-load on session start */
  autoLoad?: boolean;
  /** Save frequency in ms */
  saveInterval?: number;
}

export interface ToolPermissions {
  /** Default permission for unlisted tools */
  default: 'allow' | 'deny' | 'ask';
  /** Explicitly allowed tools */
  allow?: string[];
  /** Explicitly denied tools */
  deny?: string[];
  /** Tools requiring confirmation */
  requireConfirmation?: string[];
}

export interface CommandConfig {
  /** Allowed shell commands (glob patterns) */
  allow?: string[];
  /** Denied shell commands (glob patterns) */
  deny?: string[];
  /** Working directory restrictions */
  allowedPaths?: string[];
  /** Denied paths */
  deniedPaths?: string[];
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

export interface SkillConfig {
  /** Skill search paths */
  searchPaths?: string[];
  /** Auto-activation preferences */
  autoActivate?: {
    enabled: boolean;
    minConfidence: number;
    blocklist?: string[];
  };
  /** Custom slash commands */
  commands?: Record<string, string>;
}

export interface ModelConfig {
  /** Preferred model */
  preferred?: string;
  /** Fallback models */
  fallbacks?: string[];
  /** Temperature override */
  temperature?: number;
  /** Max tokens override */
  maxTokens?: number;
}

export interface ContextConfig {
  /** Max context tokens */
  maxTokens?: number;
  /** Auto-compaction threshold */
  compactionThreshold?: number;
  /** Preserve recent turns */
  preserveRecent?: number;
}

export interface LoadedConfig {
  config: ClaudeConfig;
  sources: ConfigSource[];
  errors: ConfigError[];
  timestamp: number;
}

export interface ConfigSource {
  path: string;
  type: 'project' | 'user' | 'custom';
  loaded: boolean;
  priority: number;
  kind?: InstructionSourceKind;
  scope?: InstructionSourceScope;
  applied?: boolean;
  label?: string;
  reason?: string;
  matchPatterns?: string[];
  matchedPaths?: string[];
}

export interface ConfigError {
  source: string;
  error: string;
  line?: number;
}

export class ClaudeMdLoader extends EventEmitter {
  private static instance: ClaudeMdLoader | null = null;
  private loadedConfig: LoadedConfig | null = null;
  private projectRoot: string = process.cwd();
  private customPaths: string[] = [];
  private watchers: Map<string, fs.FileHandle> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): ClaudeMdLoader {
    if (!ClaudeMdLoader.instance) {
      ClaudeMdLoader.instance = new ClaudeMdLoader();
    }
    return ClaudeMdLoader.instance;
  }

  static _resetForTesting(): void {
    ClaudeMdLoader.instance = null;
  }

  /**
   * Initialize with project root
   */
  async initialize(projectRoot: string): Promise<void> {
    this.projectRoot = projectRoot;
    await this.loadAll();
    this.emit('initialized', { projectRoot });
  }

  /**
   * Add a custom config path
   */
  addCustomPath(configPath: string): void {
    if (!this.customPaths.includes(configPath)) {
      this.customPaths.push(configPath);
    }
  }

  /**
   * Remove a custom config path
   */
  removeCustomPath(configPath: string): void {
    const index = this.customPaths.indexOf(configPath);
    if (index > -1) {
      this.customPaths.splice(index, 1);
    }
  }

  /**
   * Load all config files
   */
  async loadAll(): Promise<LoadedConfig> {
    const errors: ConfigError[] = [];
    const configs: Array<{ config: ClaudeConfig; priority: number }> = [];
    const resolution = await this.resolveInstructions({
      workingDirectory: this.projectRoot,
    });
    const sources: ConfigSource[] = resolution.sources.map((source) => ({
      path: source.path,
      type: source.scope === 'user'
        ? 'user'
        : source.scope === 'custom'
          ? 'custom'
          : 'project',
      loaded: source.loaded,
      priority: source.priority,
      kind: source.kind,
      scope: source.scope,
      applied: source.applied,
      label: source.label,
      reason: source.reason,
      matchPatterns: source.matchPatterns,
      matchedPaths: source.matchedPaths,
    }));

    for (const source of resolution.sources.filter((item) => item.loaded && item.applied)) {
      const filePath = source.path;
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        configs.push({
          config: this.parseContent(content),
          priority: source.priority,
        });
      } catch (error) {
        errors.push({
          source: filePath,
          error: (error as Error).message,
        });
      }
    }

    // Merge configs by priority
    const mergedConfig = this.mergeConfigs(configs);

    this.loadedConfig = {
      config: mergedConfig,
      sources,
      errors,
      timestamp: Date.now(),
    };

    this.emit('config-loaded', this.loadedConfig);
    return this.loadedConfig;
  }

  /**
   * Get current loaded config
   */
  getConfig(): ClaudeConfig | null {
    return this.loadedConfig?.config || null;
  }

  /**
   * Get full loaded config with metadata
   */
  getLoadedConfig(): LoadedConfig | null {
    return this.loadedConfig;
  }

  /**
   * Resolve the active instruction stack for a working directory.
   */
  async resolveInstructions(params?: {
    workingDirectory?: string;
    contextPaths?: string[];
  }): Promise<InstructionResolution> {
    return resolveInstructionStack({
      workingDirectory: params?.workingDirectory || this.projectRoot,
      contextPaths: params?.contextPaths,
      customPaths: this.customPaths,
    });
  }

  /**
   * Reload all config files
   */
  async reload(): Promise<LoadedConfig> {
    this.emit('reload-started');
    const result = await this.loadAll();
    this.emit('reload-completed', result);
    return result;
  }

  /**
   * Parse instruction markdown content
   */
  private parseContent(content: string): ClaudeConfig {
    const config: ClaudeConfig = {};

    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      try {
        const frontmatter = yaml.load(frontmatterMatch[1]) as Record<string, unknown>;
        Object.assign(config, this.normalizeYamlConfig(frontmatter));
      } catch (error) {
        // Invalid YAML, ignore frontmatter
      }

      // Remove frontmatter from content
      content = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
    }

    // Parse sections from markdown
    const sections = this.parseSections(content);

    // Extract instructions (any content before first section or explicit instructions section)
    if (sections['instructions']) {
      config.instructions = sections['instructions'].trim();
    } else {
      // Use content before first heading as instructions
      const firstHeadingIndex = content.search(/^#+ /m);
      if (firstHeadingIndex > 0) {
        config.instructions = content.substring(0, firstHeadingIndex).trim();
      } else if (!frontmatterMatch) {
        config.instructions = content.trim();
      }
    }

    // Parse tool permissions section
    if (sections['tools'] || sections['permissions']) {
      config.tools = this.parseToolPermissions(sections['tools'] || sections['permissions']);
    }

    // Parse commands section
    if (sections['commands']) {
      config.commands = this.parseCommands(sections['commands']);
    }

    // Parse memory section
    if (sections['memory']) {
      config.memory = this.parseMemory(sections['memory']);
    }

    // Parse environment section
    if (sections['env'] || sections['environment']) {
      config.env = this.parseEnvVars(sections['env'] || sections['environment']);
    }

    // Parse MCP servers section
    if (sections['mcp'] || sections['servers']) {
      config.mcpServers = this.parseMCPServers(sections['mcp'] || sections['servers']);
    }

    // Parse skills section
    if (sections['skills']) {
      config.skills = this.parseSkills(sections['skills']);
    }

    return config;
  }

  /**
   * Parse markdown into sections
   */
  private parseSections(content: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const sectionRegex = /^##?\s+(.+?)$/gm;
    const matches = [...content.matchAll(sectionRegex)];

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const sectionName = match[1].toLowerCase().trim();
      const startIndex = match.index! + match[0].length;
      const endIndex = matches[i + 1]?.index || content.length;
      const sectionContent = content.substring(startIndex, endIndex);

      sections[sectionName] = sectionContent.trim();
    }

    return sections;
  }

  /**
   * Normalize YAML frontmatter config
   */
  private normalizeYamlConfig(yaml: Record<string, unknown>): Partial<ClaudeConfig> {
    const config: Partial<ClaudeConfig> = {};

    if (yaml['instructions'] && typeof yaml['instructions'] === 'string') {
      config.instructions = yaml['instructions'];
    }

    if (yaml['memory'] && typeof yaml['memory'] === 'object') {
      config.memory = yaml['memory'] as MemoryConfig;
    }

    if (yaml['tools'] && typeof yaml['tools'] === 'object') {
      config.tools = yaml['tools'] as ToolPermissions;
    }

    if (yaml['commands'] && typeof yaml['commands'] === 'object') {
      config.commands = yaml['commands'] as CommandConfig;
    }

    if (yaml['env'] && typeof yaml['env'] === 'object') {
      config.env = yaml['env'] as Record<string, string>;
    }

    if (yaml['mcpServers'] && Array.isArray(yaml['mcpServers'])) {
      config.mcpServers = yaml['mcpServers'] as MCPServerConfig[];
    }

    if (yaml['skills'] && typeof yaml['skills'] === 'object') {
      config.skills = yaml['skills'] as SkillConfig;
    }

    if (yaml['model'] && typeof yaml['model'] === 'object') {
      config.model = yaml['model'] as ModelConfig;
    }

    if (yaml['context'] && typeof yaml['context'] === 'object') {
      config.context = yaml['context'] as ContextConfig;
    }

    if (yaml['metadata'] && typeof yaml['metadata'] === 'object') {
      config.metadata = yaml['metadata'] as Record<string, unknown>;
    }

    return config;
  }

  /**
   * Parse tool permissions from section content
   */
  private parseToolPermissions(content: string): ToolPermissions {
    const permissions: ToolPermissions = {
      default: 'allow',
    };

    // Parse allowed tools
    const allowMatch = content.match(/allowed?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (allowMatch) {
      permissions.allow = this.parseList(allowMatch[1]);
    }

    // Parse denied tools
    const denyMatch = content.match(/denied?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (denyMatch) {
      permissions.deny = this.parseList(denyMatch[1]);
    }

    // Parse confirmation required
    const confirmMatch = content.match(/confirm(?:ation)?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (confirmMatch) {
      permissions.requireConfirmation = this.parseList(confirmMatch[1]);
    }

    // Parse default
    if (content.toLowerCase().includes('default: deny')) {
      permissions.default = 'deny';
    } else if (content.toLowerCase().includes('default: ask')) {
      permissions.default = 'ask';
    }

    return permissions;
  }

  /**
   * Parse commands section
   */
  private parseCommands(content: string): CommandConfig {
    const commands: CommandConfig = {};

    const allowMatch = content.match(/allowed?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (allowMatch) {
      commands.allow = this.parseList(allowMatch[1]);
    }

    const denyMatch = content.match(/denied?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (denyMatch) {
      commands.deny = this.parseList(denyMatch[1]);
    }

    const pathsMatch = content.match(/allowed?\s*paths?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (pathsMatch) {
      commands.allowedPaths = this.parseList(pathsMatch[1]);
    }

    return commands;
  }

  /**
   * Parse memory section
   */
  private parseMemory(content: string): MemoryConfig {
    const memory: MemoryConfig = {
      enabled: true,
    };

    if (content.toLowerCase().includes('enabled: false') ||
        content.toLowerCase().includes('disabled')) {
      memory.enabled = false;
    }

    const pathsMatch = content.match(/paths?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (pathsMatch) {
      memory.paths = this.parseList(pathsMatch[1]);
    }

    if (content.toLowerCase().includes('autoload') ||
        content.toLowerCase().includes('auto-load')) {
      memory.autoLoad = !content.toLowerCase().includes('autoload: false');
    }

    return memory;
  }

  /**
   * Parse environment variables
   */
  private parseEnvVars(content: string): Record<string, string> {
    const env: Record<string, string> = {};

    // Parse KEY=value format
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[-*]?\s*(\w+)\s*[:=]\s*(.+)\s*$/);
      if (match) {
        env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    }

    return env;
  }

  /**
   * Parse MCP servers section
   */
  private parseMCPServers(content: string): MCPServerConfig[] {
    const servers: MCPServerConfig[] = [];

    // Try to parse as YAML list
    try {
      const parsed = yaml.load(content) as MCPServerConfig[];
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not valid YAML, try line-by-line parsing
    }

    // Parse simple format: - name: command
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s*(\w+):\s*(.+)\s*$/);
      if (match) {
        servers.push({
          name: match[1],
          command: match[2].trim(),
          enabled: true,
        });
      }
    }

    return servers;
  }

  /**
   * Parse skills section
   */
  private parseSkills(content: string): SkillConfig {
    const skills: SkillConfig = {};

    const pathsMatch = content.match(/search\s*paths?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (pathsMatch) {
      skills.searchPaths = this.parseList(pathsMatch[1]);
    }

    // Parse custom commands
    const commandsMatch = content.match(/commands?:?\s*\n((?:\s*[-*]\s+.+\n?)+)/i);
    if (commandsMatch) {
      skills.commands = {};
      const lines = commandsMatch[1].split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*[-*]\s*\/(\w+):\s*(.+)\s*$/);
        if (match) {
          skills.commands[match[1]] = match[2].trim();
        }
      }
    }

    return skills;
  }

  /**
   * Parse a markdown list
   */
  private parseList(content: string): string[] {
    const items: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const match = line.match(/^\s*[-*]\s+(.+)\s*$/);
      if (match) {
        items.push(match[1].trim());
      }
    }

    return items;
  }

  /**
   * Merge configs by priority
   */
  private mergeConfigs(configs: Array<{ config: ClaudeConfig; priority: number }>): ClaudeConfig {
    // Sort by priority (lower first, so higher priority overwrites)
    configs.sort((a, b) => a.priority - b.priority);

    const merged: ClaudeConfig = {};

    for (const { config } of configs) {
      // Instructions: concatenate
      if (config.instructions) {
        merged.instructions = merged.instructions
          ? `${merged.instructions}\n\n${config.instructions}`
          : config.instructions;
      }

      // Memory: deep merge
      if (config.memory) {
        merged.memory = { ...merged.memory, ...config.memory };
        if (config.memory.paths) {
          merged.memory.paths = [
            ...(merged.memory.paths || []),
            ...config.memory.paths,
          ];
        }
      }

      // Tools: merge lists
      if (config.tools) {
        merged.tools = merged.tools || { default: 'allow' };
        if (config.tools.default) {
          merged.tools.default = config.tools.default;
        }
        if (config.tools.allow) {
          merged.tools.allow = [...(merged.tools.allow || []), ...config.tools.allow];
        }
        if (config.tools.deny) {
          merged.tools.deny = [...(merged.tools.deny || []), ...config.tools.deny];
        }
        if (config.tools.requireConfirmation) {
          merged.tools.requireConfirmation = [
            ...(merged.tools.requireConfirmation || []),
            ...config.tools.requireConfirmation,
          ];
        }
      }

      // Commands: merge lists
      if (config.commands) {
        merged.commands = merged.commands || {};
        if (config.commands.allow) {
          merged.commands.allow = [...(merged.commands.allow || []), ...config.commands.allow];
        }
        if (config.commands.deny) {
          merged.commands.deny = [...(merged.commands.deny || []), ...config.commands.deny];
        }
        if (config.commands.allowedPaths) {
          merged.commands.allowedPaths = [
            ...(merged.commands.allowedPaths || []),
            ...config.commands.allowedPaths,
          ];
        }
      }

      // Env: overwrite
      if (config.env) {
        merged.env = { ...merged.env, ...config.env };
      }

      // MCP servers: append
      if (config.mcpServers) {
        merged.mcpServers = [...(merged.mcpServers || []), ...config.mcpServers];
      }

      // Skills: merge
      if (config.skills) {
        merged.skills = merged.skills || {};
        if (config.skills.searchPaths) {
          merged.skills.searchPaths = [
            ...(merged.skills.searchPaths || []),
            ...config.skills.searchPaths,
          ];
        }
        if (config.skills.commands) {
          merged.skills.commands = { ...merged.skills.commands, ...config.skills.commands };
        }
        if (config.skills.autoActivate) {
          merged.skills.autoActivate = {
            ...merged.skills.autoActivate,
            ...config.skills.autoActivate,
          };
        }
      }

      // Model: overwrite
      if (config.model) {
        merged.model = { ...merged.model, ...config.model };
      }

      // Context: overwrite
      if (config.context) {
        merged.context = { ...merged.context, ...config.context };
      }

      // Metadata: deep merge
      if (config.metadata) {
        merged.metadata = { ...merged.metadata, ...config.metadata };
      }
    }

    return merged;
  }

  /**
   * Generate instructions string from config
   */
  getInstructions(): string {
    return this.loadedConfig?.config.instructions || '';
  }

  /**
   * Check if a tool is allowed
   */
  isToolAllowed(toolName: string): 'allow' | 'deny' | 'ask' {
    const tools = this.loadedConfig?.config.tools;
    if (!tools) return 'allow';

    if (tools.deny?.includes(toolName)) {
      return 'deny';
    }

    if (tools.requireConfirmation?.includes(toolName)) {
      return 'ask';
    }

    if (tools.allow?.includes(toolName)) {
      return 'allow';
    }

    return tools.default;
  }

  /**
   * Check if a command is allowed
   */
  isCommandAllowed(command: string): boolean {
    const commands = this.loadedConfig?.config.commands;
    if (!commands) return true;

    // Check deny list first
    if (commands.deny) {
      for (const pattern of commands.deny) {
        if (this.matchGlob(command, pattern)) {
          return false;
        }
      }
    }

    // Check allow list
    if (commands.allow) {
      for (const pattern of commands.allow) {
        if (this.matchGlob(command, pattern)) {
          return true;
        }
      }
      // If allow list exists but command not in it, deny
      return false;
    }

    return true;
  }

  private matchGlob(value: string, pattern: string): boolean {
    const regexPattern = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(value);
  }
}

export function getClaudeMdLoader(): ClaudeMdLoader {
  return ClaudeMdLoader.getInstance();
}

export default ClaudeMdLoader;
