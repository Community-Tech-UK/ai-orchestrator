/**
 * CLI Detection Service - Auto-detects and caches available AI CLI tools
 * Supports Claude Code, OpenAI Codex, Google Gemini, Ollama, and more
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { CliCapabilities } from './adapters/base-cli-adapter';
import { getLogger } from '../logging/logger';

const logger = getLogger('CliDetection');

/**
 * Information about a detected CLI tool
 */
export interface CliInfo {
  name: string;
  command: string;
  displayName: string;
  installed: boolean;
  version?: string;
  path?: string;
  authenticated?: boolean;
  error?: string;
  capabilities?: string[];
}

/**
 * Result of CLI detection
 */
export interface DetectionResult {
  detected: CliInfo[];
  available: CliInfo[];
  unavailable: CliInfo[];
  timestamp: Date;
}

/**
 * CLI type identifiers - only CLIs with provider implementations
 */
export type CliType = 'claude' | 'codex' | 'gemini' | 'copilot' | 'ollama' | 'cursor';

/**
 * CLIs that have provider implementations and can be used for verification
 */
export const SUPPORTED_CLIS: CliType[] = ['claude', 'codex', 'gemini', 'copilot', 'ollama', 'cursor'];

/**
 * Registry entry for a CLI tool
 */
interface CliRegistryEntry {
  name: string;
  command: string;
  displayName: string;
  versionFlag: string;
  versionPattern: RegExp;
  authCheckFlag?: string;
  authPattern?: RegExp;
  capabilities: string[];
  alternativePaths: string[];
}

/**
 * Registry of known CLI tools - only includes CLIs with provider implementations
 */
export const CLI_REGISTRY: Record<CliType, CliRegistryEntry> = {
  claude: {
    name: 'claude',
    command: 'claude',
    displayName: 'Claude Code',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      `${process.env['HOME']}/.local/bin/claude`
    ]
  },
  codex: {
    name: 'codex',
    command: 'codex',
    displayName: 'OpenAI Codex CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'code-execution'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      `${process.env['HOME']}/.local/bin/codex`
    ]
  },
  gemini: {
    name: 'gemini',
    command: 'gemini',
    displayName: 'Google Gemini CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision',
      'large-context'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/gemini',
      '/usr/local/bin/gemini',
      `${process.env['HOME']}/.local/bin/gemini`
    ]
  },
  copilot: {
    name: 'copilot',
    command: 'copilot',
    displayName: 'GitHub Copilot',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision',
      'mcp-servers'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/copilot',
      '/usr/local/bin/copilot',
      `${process.env['HOME']}/.local/bin/copilot`,
      `${process.env['HOME']}/.npm-global/bin/copilot`
    ]
  },
  cursor: {
    name: 'cursor',
    command: 'cursor-agent',
    displayName: 'Cursor CLI',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: [
      'streaming',
      'tool-use',
      'file-access',
      'shell',
      'multi-turn',
      'vision'
    ],
    alternativePaths: [
      '/opt/homebrew/bin/cursor-agent',
      '/usr/local/bin/cursor-agent',
      `${process.env['HOME']}/.local/bin/cursor-agent`,
      `${process.env['HOME']}/.cursor/bin/cursor-agent`
    ]
  },
  ollama: {
    name: 'ollama',
    command: 'ollama',
    displayName: 'Ollama',
    versionFlag: '--version',
    versionPattern: /(\d+\.\d+\.\d+)/,
    capabilities: ['streaming', 'multi-turn', 'local'],
    alternativePaths: [
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      `${process.env['HOME']}/.ollama/bin/ollama`,
      '/Applications/Ollama.app/Contents/MacOS/ollama'
    ]
  }
};

/**
 * CLI Detection Service - Singleton that detects and caches available CLI tools
 */
export class CliDetectionService {
  private static instance: CliDetectionService | null = null;
  private cache: DetectionResult | null = null;
  private cacheTimeout = 60000; // 1 minute cache
  private cacheTime = 0;

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): CliDetectionService {
    if (!this.instance) {
      this.instance = new CliDetectionService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    CliDetectionService.instance = null;
  }

  /**
   * Detect all available CLI tools
   */
  async detectAll(forceRefresh = false): Promise<DetectionResult> {
    logger.debug('detectAll called', { forceRefresh, home: process.env['HOME'] });

    // Check cache
    if (!forceRefresh && this.cache) {
      const age = Date.now() - this.cacheTime;
      if (age < this.cacheTimeout) {
        logger.debug('Returning cached result');
        return this.cache;
      }
    }

    // Detect only supported CLIs (ones with provider implementations)
    const cliTypes = SUPPORTED_CLIS;
    logger.debug('Checking CLIs', { cliTypes });
    const results = await Promise.all(
      cliTypes.map((type) => this.checkCli(type))
    );

    logger.debug('Detection results', {
      results: results.map((r) => ({
        name: r.name,
        installed: r.installed,
        version: r.version,
        path: r.path,
        error: r.error
      }))
    });

    const detectionResult: DetectionResult = {
      detected: results,
      available: results.filter((r) => r.installed),
      unavailable: results.filter((r) => !r.installed),
      timestamp: new Date()
    };

    logger.info('CLI detection complete', {
      available: detectionResult.available.map((r) => r.name)
    });

    // Update cache
    this.cache = detectionResult;
    this.cacheTime = Date.now();

    return detectionResult;
  }

  /**
   * Detect a specific CLI tool
   */
  async detectOne(type: CliType): Promise<CliInfo> {
    return this.checkCli(type);
  }

  /**
   * Check if a specific CLI is available
   */
  async isInstalled(type: CliType): Promise<boolean> {
    const info = await this.detectOne(type);
    return info.installed;
  }

  /**
   * Get the list of known CLI types
   */
  getKnownClis(): CliType[] {
    return Object.keys(CLI_REGISTRY) as CliType[];
  }

  /**
   * Get CLI registry entry
   */
  getCliConfig(type: CliType): CliRegistryEntry | undefined {
    return CLI_REGISTRY[type];
  }

  /**
   * Get the first available CLI
   */
  async getDefaultCli(): Promise<CliInfo | null> {
    const result = await this.detectAll();
    // Prefer claude, then gemini, then codex, then copilot, then others
    const priority: CliType[] = ['claude', 'gemini', 'codex', 'copilot', 'cursor', 'ollama'];
    for (const type of priority) {
      const cli = result.available.find((c) => c.name === type);
      if (cli) return cli;
    }
    return result.available[0] || null;
  }

  /**
   * Clear the detection cache
   */
  clearCache(): void {
    this.cache = null;
    this.cacheTime = 0;
  }

  /**
   * Set cache timeout
   */
  setCacheTimeout(ms: number): void {
    this.cacheTimeout = ms;
  }

  /**
   * Check a specific CLI tool
   */
  private async checkCli(type: CliType): Promise<CliInfo> {
    const config = CLI_REGISTRY[type];
    if (!config) {
      return {
        name: type,
        command: type,
        displayName: type,
        installed: false,
        error: 'Unknown CLI type'
      };
    }

    // First try the main command
    let result = await this.checkCommand(config.command, config);

    // If not found, try alternative paths
    if (!result.installed && config.alternativePaths.length > 0) {
      for (const altPath of config.alternativePaths) {
        // Expand home directory
        const expandedPath = altPath.replace('~', process.env['HOME'] || '');
        if (existsSync(expandedPath)) {
          result = await this.checkCommand(expandedPath, config);
          if (result.installed) {
            result.path = expandedPath;
            break;
          }
        }
      }
    }

    return result;
  }

  /**
   * Check if a specific command is available
   */
  private checkCommand(
    command: string,
    config: CliRegistryEntry
  ): Promise<CliInfo> {
    return new Promise((resolve) => {
      const result: CliInfo = {
        name: config.name,
        command: config.command,
        displayName: config.displayName,
        installed: false,
        capabilities: config.capabilities
      };

      // Allow alternative paths (absolute paths starting with / or expanded ~)
      // The guard only rejects if someone passes a different command name
      const isAbsolutePath = command.startsWith('/');
      if (!isAbsolutePath && command !== config.command) {
        result.error = 'Invalid CLI command';
        resolve(result);
        return;
      }
      try {
        // Build the version check arguments
        const args = config.versionFlag.split(' ');

        // Extend PATH to include common CLI installation directories
        // This is needed for packaged Electron apps where PATH may be limited
        const homeDir = process.env['HOME'] || process.env['USERPROFILE'] || '';
        const additionalPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${homeDir}/.local/bin`,
          `${homeDir}/.npm-global/bin`,
          `${homeDir}/.nvm/versions/node/current/bin`,
          '/usr/bin',
          '/bin'
        ].filter(Boolean);
        const currentPath = process.env['PATH'] || '';
        const extendedPath = [...additionalPaths, currentPath].join(':');

        logger.debug('Checking command', {
          command,
          args: args.join(' '),
          home: homeDir,
          additionalPaths
        });

        const proc = spawn(command, args, {
          timeout: 5000,
          env: { ...process.env, PATH: extendedPath }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          const output = stdout + stderr;
          const versionMatch = output.match(config.versionPattern);

          logger.debug('Command close event', {
            command,
            code,
            stdoutPreview: stdout.substring(0, 100),
            stderrPreview: stderr.substring(0, 100)
          });

          if (code === 0 || versionMatch) {
            result.installed = true;
            result.version = versionMatch?.[1];
            result.path = command;
            result.authenticated = !output.includes('not authenticated');
            logger.info('CLI detected', { command, version: result.version });
          } else {
            result.error = stderr.trim() || 'Command failed';
            logger.debug('CLI not detected', { command, error: result.error });
          }
          resolve(result);
        });

        proc.on('error', (err) => {
          logger.debug('Command error event', { command, error: err.message });
          result.error = err.message;
          resolve(result);
        });

        // Timeout fallback
        setTimeout(() => {
          if (!result.installed && !result.error) {
            proc.kill();
            result.error = 'Timeout checking CLI';
            resolve(result);
          }
        }, 5000);
      } catch (err) {
        result.error = (err as Error).message;
        resolve(result);
      }
    });
  }

  /**
   * Map capability strings to CliCapabilities object
   */
  mapCapabilities(capabilities: string[]): CliCapabilities {
    return {
      streaming: capabilities.includes('streaming'),
      toolUse: capabilities.includes('tool-use'),
      fileAccess: capabilities.includes('file-access'),
      shellExecution: capabilities.includes('shell'),
      multiTurn: capabilities.includes('multi-turn'),
      vision: capabilities.includes('vision'),
      codeExecution:
        capabilities.includes('code-execution') ||
        capabilities.includes('shell'),
      contextWindow: capabilities.includes('large-context') ? 1000000 : 200000,
      outputFormats: ['text']
    };
  }
}

export function getCliDetectionService(): CliDetectionService {
  return CliDetectionService.getInstance();
}

// Convenience functions for backward compatibility
export async function detectAvailableClis(): Promise<CliInfo[]> {
  const service = CliDetectionService.getInstance();
  const result = await service.detectAll();
  return result.detected;
}

export async function isCliAvailable(type: CliType): Promise<CliInfo> {
  const service = CliDetectionService.getInstance();
  return service.detectOne(type);
}

export async function getDefaultCli(): Promise<CliInfo | null> {
  const service = CliDetectionService.getInstance();
  return service.getDefaultCli();
}

export function getCliConfig(type: CliType): CliRegistryEntry | undefined {
  return CLI_REGISTRY[type];
}
