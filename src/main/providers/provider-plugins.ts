/**
 * Provider Plugins - Add custom AI providers via plugins (12.2)
 *
 * Allows dynamic loading of custom AI provider implementations.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { app } from 'electron';
import { EventEmitter } from 'events';
import type { ProviderType, ProviderConfig, ProviderCapabilities, ModelInfo } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderPlugins');

/**
 * Provider plugin interface that custom providers must implement
 */
export interface ProviderPlugin {
  /** Unique provider identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Version string */
  version: string;
  /** Author information */
  author?: string;
  /** Provider capabilities */
  capabilities: ProviderCapabilities;
  /** Available models */
  models: ModelInfo[];

  /** Initialize the provider */
  initialize(config: Record<string, unknown>): Promise<void>;
  /** Check if provider is available/authenticated */
  isAvailable(): Promise<boolean>;
  /** Send a message and get a response */
  sendMessage(messages: PluginMessage[], options: PluginOptions): AsyncGenerator<PluginEvent>;
  /** Cleanup resources */
  dispose(): Promise<void>;
}

/**
 * Message format for plugins
 */
export interface PluginMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Options for message sending
 */
export interface PluginOptions {
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

/**
 * Events emitted by plugins during message processing
 */
export type PluginEvent =
  | { type: 'text'; content: string }
  | { type: 'done'; usage?: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string };

/**
 * Plugin metadata
 */
export interface PluginMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  filePath: string;
  loaded: boolean;
  error?: string;
}

/**
 * Plugin loading options
 */
export interface PluginLoadOptions {
  timeout?: number;
  sandbox?: boolean;
}

/**
 * Provider Plugins Manager
 */
export class ProviderPluginsManager extends EventEmitter {
  private pluginsDir: string;
  private plugins: Map<string, ProviderPlugin> = new Map();
  private pluginMeta: Map<string, PluginMeta> = new Map();

  constructor() {
    super();
    this.pluginsDir = path.join(app.getPath('userData'), 'provider-plugins');
    this.ensurePluginsDir();
  }

  /**
   * Ensure plugins directory exists
   */
  private ensurePluginsDir(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
  }

  /**
   * Discover plugins in the plugins directory
   */
  async discoverPlugins(): Promise<PluginMeta[]> {
    const metas: PluginMeta[] = [];

    try {
      const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.mjs'))) {
          const filePath = path.join(this.pluginsDir, entry.name);
          const meta = await this.getPluginMeta(filePath);
          if (meta) {
            metas.push(meta);
            this.pluginMeta.set(meta.id, meta);
          }
        } else if (entry.isDirectory()) {
          // Check for index.js in directory
          const indexPath = path.join(this.pluginsDir, entry.name, 'index.js');
          if (fs.existsSync(indexPath)) {
            const meta = await this.getPluginMeta(indexPath);
            if (meta) {
              metas.push(meta);
              this.pluginMeta.set(meta.id, meta);
            }
          }
        }
      }
    } catch (error) {
      logger.error('Failed to discover plugins', error instanceof Error ? error : undefined);
    }

    return metas;
  }

  /**
   * Get plugin metadata without fully loading it
   */
  private async getPluginMeta(filePath: string): Promise<PluginMeta | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Try to extract metadata from exports
      const idMatch = content.match(/id\s*[:=]\s*['"]([^'"]+)['"]/);
      const nameMatch = content.match(/name\s*[:=]\s*['"]([^'"]+)['"]/);
      const descMatch = content.match(/description\s*[:=]\s*['"]([^'"]+)['"]/);
      const versionMatch = content.match(/version\s*[:=]\s*['"]([^'"]+)['"]/);
      const authorMatch = content.match(/author\s*[:=]\s*['"]([^'"]+)['"]/);

      if (!idMatch || !nameMatch) {
        return null;
      }

      return {
        id: idMatch[1],
        name: nameMatch[1],
        description: descMatch?.[1] || '',
        version: versionMatch?.[1] || '1.0.0',
        author: authorMatch?.[1],
        filePath,
        loaded: false,
      };
    } catch (error: any) {
      return {
        id: path.basename(filePath, path.extname(filePath)),
        name: path.basename(filePath),
        description: 'Failed to read metadata',
        version: 'unknown',
        filePath,
        loaded: false,
        error: error.message,
      };
    }
  }

  /**
   * Load a plugin by ID or file path
   */
  async loadPlugin(
    idOrPath: string,
    options: PluginLoadOptions = {}
  ): Promise<ProviderPlugin | null> {
    const { timeout = 5000, sandbox = true } = options;

    // Find the plugin file
    let filePath: string;
    const meta = this.pluginMeta.get(idOrPath);
    if (meta) {
      filePath = meta.filePath;
    } else if (fs.existsSync(idOrPath)) {
      filePath = idOrPath;
    } else {
      filePath = path.join(this.pluginsDir, idOrPath);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Plugin not found: ${idOrPath}`);
      }
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Create a sandboxed context for the plugin
      const context = this.createPluginContext(sandbox);

      // Run the plugin code
      const script = new vm.Script(`
        (function() {
          ${content}
          return typeof module !== 'undefined' ? module.exports : exports;
        })()
      `, { filename: filePath });

      const pluginExports = script.runInContext(context, { timeout });

      // Validate plugin interface
      const plugin = this.validatePlugin(pluginExports);
      if (!plugin) {
        throw new Error('Plugin does not implement required interface');
      }

      // Store the plugin
      this.plugins.set(plugin.id, plugin);

      // Update metadata
      const updatedMeta = this.pluginMeta.get(plugin.id);
      if (updatedMeta) {
        updatedMeta.loaded = true;
        delete updatedMeta.error;
      }

      this.emit('plugin-loaded', plugin.id);
      return plugin;
    } catch (error: any) {
      const meta = this.pluginMeta.get(idOrPath);
      if (meta) {
        meta.error = error.message;
      }
      this.emit('plugin-error', idOrPath, error);
      throw error;
    }
  }

  /**
   * Create a sandboxed context for plugin execution
   */
  private createPluginContext(sandbox: boolean): vm.Context {
    const baseContext: Record<string, unknown> = {
      console: {
        log: (...args: unknown[]) => logger.info('Plugin log', { args }),
        error: (...args: unknown[]) => logger.error('Plugin error', undefined, { args }),
        warn: (...args: unknown[]) => logger.warn('Plugin warn', { args }),
      },
      module: { exports: {} },
      exports: {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      Promise,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
    };

    if (!sandbox) {
      // Allow Node.js modules in non-sandboxed mode
      baseContext['require'] = require;
      baseContext['process'] = { env: process.env };
    }

    return vm.createContext(baseContext);
  }

  /**
   * Validate that an object implements ProviderPlugin
   */
  private validatePlugin(obj: unknown): ProviderPlugin | null {
    if (typeof obj !== 'object' || obj === null) {
      return null;
    }

    const plugin = obj as Record<string, unknown>;

    // Check required properties
    if (typeof plugin['id'] !== 'string') return null;
    if (typeof plugin['name'] !== 'string') return null;
    if (typeof plugin['initialize'] !== 'function') return null;
    if (typeof plugin['isAvailable'] !== 'function') return null;
    if (typeof plugin['sendMessage'] !== 'function') return null;
    if (typeof plugin['dispose'] !== 'function') return null;

    return obj as unknown as ProviderPlugin;
  }

  /**
   * Unload a plugin
   */
  async unloadPlugin(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;

    try {
      await plugin.dispose();
    } catch (error) {
      logger.error('Error disposing plugin', error instanceof Error ? error : undefined, { pluginId });
    }

    this.plugins.delete(pluginId);

    const meta = this.pluginMeta.get(pluginId);
    if (meta) {
      meta.loaded = false;
    }

    this.emit('plugin-unloaded', pluginId);
  }

  /**
   * Get a loaded plugin
   */
  getPlugin(pluginId: string): ProviderPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /**
   * Get all loaded plugins
   */
  getLoadedPlugins(): ProviderPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get all plugin metadata
   */
  getAllPluginMeta(): PluginMeta[] {
    return Array.from(this.pluginMeta.values());
  }

  /**
   * Install a plugin from a file
   */
  async installPlugin(sourcePath: string): Promise<PluginMeta | null> {
    const fileName = path.basename(sourcePath);
    const destPath = path.join(this.pluginsDir, fileName);

    try {
      // Copy the file
      fs.copyFileSync(sourcePath, destPath);

      // Get metadata
      const meta = await this.getPluginMeta(destPath);
      if (meta) {
        this.pluginMeta.set(meta.id, meta);
        this.emit('plugin-installed', meta.id);
      }

      return meta;
    } catch (error: any) {
      throw new Error(`Failed to install plugin: ${error.message}`);
    }
  }

  /**
   * Uninstall a plugin
   */
  async uninstallPlugin(pluginId: string): Promise<void> {
    // Unload first
    await this.unloadPlugin(pluginId);

    const meta = this.pluginMeta.get(pluginId);
    if (meta) {
      try {
        fs.unlinkSync(meta.filePath);
      } catch (error) {
        logger.error('Failed to delete plugin file', error instanceof Error ? error : undefined, { filePath: meta.filePath });
      }
      this.pluginMeta.delete(pluginId);
    }

    this.emit('plugin-uninstalled', pluginId);
  }

  /**
   * Convert plugin to provider config
   */
  pluginToProviderConfig(plugin: ProviderPlugin): ProviderConfig {
    return {
      type: plugin.id as ProviderType,
      name: plugin.name,
      enabled: true,
      models: plugin.models,
    };
  }

  /**
   * Create a sample plugin template
   */
  createPluginTemplate(name: string): string {
    return `/**
 * ${name} - Custom AI Provider Plugin
 */

module.exports = {
  // Required: Unique identifier
  id: '${name.toLowerCase().replace(/\s+/g, '-')}',

  // Required: Display name
  name: '${name}',

  // Optional: Description
  description: 'A custom AI provider',

  // Optional: Version
  version: '1.0.0',

  // Optional: Author
  author: 'Your Name',

  // Required: Provider capabilities
  capabilities: {
    toolExecution: false,
    streaming: true,
    multiTurn: true,
    vision: false,
    fileAttachments: false,
    functionCalling: false,
    builtInCodeTools: false,
  },

  // Required: Available models
  models: [
    {
      id: 'default',
      name: 'Default Model',
      provider: '${name.toLowerCase().replace(/\s+/g, '-')}',
      contextWindow: 4096,
      maxOutputTokens: 2048,
      inputPricePerMillion: 1.0,
      outputPricePerMillion: 2.0,
    },
  ],

  // Internal state
  _config: null,

  // Required: Initialize the provider
  async initialize(config) {
    this._config = config;
    // Add your initialization logic here
    // e.g., validate API keys, set up connections
  },

  // Required: Check if provider is available
  async isAvailable() {
    // Return true if the provider is ready to use
    return this._config !== null;
  },

  // Required: Send a message (generator function for streaming)
  async *sendMessage(messages, options) {
    // Your implementation here
    // Yield events as the response streams in

    // Example:
    yield { type: 'text', content: 'Hello from ${name}!' };
    yield {
      type: 'done',
      usage: { inputTokens: 10, outputTokens: 5 }
    };
  },

  // Required: Cleanup resources
  async dispose() {
    this._config = null;
    // Add cleanup logic here
  },
};
`;
  }

  /**
   * Save a plugin template to the plugins directory
   */
  savePluginTemplate(name: string): string {
    const content = this.createPluginTemplate(name);
    const fileName = `${name.toLowerCase().replace(/\s+/g, '-')}.js`;
    const filePath = path.join(this.pluginsDir, fileName);
    fs.writeFileSync(filePath, content);
    return filePath;
  }
}

// Singleton instance
let providerPluginsInstance: ProviderPluginsManager | null = null;

export function getProviderPluginsManager(): ProviderPluginsManager {
  if (!providerPluginsInstance) {
    providerPluginsInstance = new ProviderPluginsManager();
  }
  return providerPluginsInstance;
}
