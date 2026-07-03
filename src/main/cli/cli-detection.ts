/**
 * CLI Detection Service - Auto-detects and caches available AI CLI tools
 * Supports Claude Code, OpenAI Codex, Google Gemini, Ollama, and more
 */

import { spawn } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import { win32 as pathWin32, posix as pathPosix } from 'path';
import { CliCapabilities } from './adapters/base-cli-adapter';
import { getLogger } from '../logging/logger';
import { buildCliSpawnOptions, getCliAdditionalPaths } from './cli-environment';
import { resolveCopilotCliLaunch } from './copilot-cli-launch';
import {
  CLI_REGISTRY,
  SUPPORTED_CLIS,
  WINDOWS_EXECUTABLE_EXTENSIONS,
  getCliCandidatePaths,
  type CliRegistryEntry,
  type CliType,
} from './cli-registry';

// Re-exported for back-compat: existing importers reference these from
// './cli-detection'. The definitions now live in ./cli-registry.
export { CLI_REGISTRY, SUPPORTED_CLIS };
export type { CliType };

const logger = getLogger('CliDetection');

function quoteWindowsShellCommand(command: string): string {
  return `"${command.replace(/"/g, '""')}"`;
}

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
 * One concrete installation of a CLI found on disk.
 */
export interface CliInstall {
  path: string;
  version?: string;
  installed: boolean;
  error?: string;
}

/**
 * A shadow report — emitted when a CLI has more than one install on disk
 * reporting different versions.  `installs` is ordered by PATH search
 * priority (first = the one the app will actually use).
 */
export interface CliShadowReport {
  cli: CliType;
  installs: CliInstall[];
  activePath?: string;
  activeVersion?: string;
}

/**
 * CLI Detection Service - Singleton that detects and caches available CLI tools
 */
export class CliDetectionService {
  private static instance: CliDetectionService | null = null;
  private cache: DetectionResult | null = null;
  private cacheTimeout = 60000; // 1 minute cache
  private cacheTime = 0;
  private inFlightNormal: Promise<DetectionResult> | null = null;
  private inFlightForced: Promise<DetectionResult> | null = null;

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

    // Check cache (only for non-forced calls)
    if (!forceRefresh && this.cache) {
      const age = Date.now() - this.cacheTime;
      if (age < this.cacheTimeout) {
        logger.debug('Returning cached result');
        return this.cache;
      }
    }

    // Deduplicate concurrent scans: return the in-flight promise if one is running.
    if (forceRefresh) {
      if (this.inFlightForced) {
        logger.debug('Reusing in-flight forced scan');
        return this.inFlightForced;
      }
    } else {
      if (this.inFlightNormal) {
        logger.debug('Reusing in-flight normal scan');
        return this.inFlightNormal;
      }
    }

    const scan = this.runScan();

    if (forceRefresh) {
      this.inFlightForced = scan;
      scan.finally(() => { this.inFlightForced = null; });
    } else {
      this.inFlightNormal = scan;
      scan.finally(() => { this.inFlightNormal = null; });
    }

    return scan;
  }

  private async runScan(): Promise<DetectionResult> {
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
    // Prefer claude, then antigravity, then codex, then copilot, then others
    const priority: CliType[] = ['claude', 'antigravity', 'codex', 'copilot', 'cursor', 'ollama'];
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

    if (type === 'copilot') {
      const launch = resolveCopilotCliLaunch();
      if (!launch) {
        return {
          name: config.name,
          command: 'gh copilot',
          displayName: config.displayName,
          installed: false,
          capabilities: config.capabilities,
          error: 'Neither `copilot` nor `gh copilot` was found',
        };
      }

      return this.checkCommand(
        launch.command,
        config,
        [...launch.argsPrefix, '--version'],
        launch.displayCommand,
      );
    }

    // First try the main command
    let result = await this.checkCommand(config.command, config);

    // If not found, try alternative paths. On Windows this also covers npm
    // shims (`<cmd>.cmd`) and native-installer binaries (`<cmd>.exe`) across
    // every known install dir — see getCliCandidatePaths.
    const candidatePaths = getCliCandidatePaths(config);
    if (!result.installed && candidatePaths.length > 0) {
      for (const expandedPath of candidatePaths) {
        if (existsSync(expandedPath)) {
          result = await this.checkCommand(expandedPath, config);
          if (result.installed) {
            result.path = expandedPath;
            break;
          }
        }
      }
    }

    // Last-resort fallback: if every `--version` probe failed (typically a
    // transient SIGTERM/timeout under fork pressure when 6 CLI scans run
    // concurrently at startup) but the binary still exists on disk at a
    // known install path, trust file existence as proof of installation.
    // We surface the binary path without a version; the UI already handles
    // missing version (renders "Unknown"). Without this fallback, a single
    // slow startup can poison the 60s cache and make the Startup Capability
    // probe falsely report "<CLI> is not available on PATH" — see app.log
    // entries where ProviderDoctor's lighter `which` probe reported the
    // same CLI as healthy in the same run.
    if (!result.installed) {
      for (const expandedPath of candidatePaths) {
        if (existsSync(expandedPath)) {
          logger.warn(
            'CLI version probe failed for every candidate, but binary exists on disk — marking installed by path',
            {
              cli: type,
              path: expandedPath,
              lastError: result.error,
            },
          );
          result = {
            name: config.name,
            command: config.command,
            displayName: config.displayName,
            installed: true,
            path: expandedPath,
            // version intentionally left undefined — we couldn't probe it.
            // authenticated likewise unknown; downstream auth probes handle this.
            capabilities: config.capabilities,
          };
          break;
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
    config: CliRegistryEntry,
    argsOverride?: string[],
    reportedCommand?: string,
  ): Promise<CliInfo> {
    return new Promise((resolve) => {
      const result: CliInfo = {
        name: config.name,
        command: reportedCommand ?? config.command,
        displayName: config.displayName,
        installed: false,
        capabilities: config.capabilities
      };

      // Allow alternative paths (absolute paths starting with / or expanded ~)
      // The guard only rejects if someone passes a different command name.
      // Use platform-appropriate absolute-path semantics: on Windows a native
      // path like `C:\Users\...\claude.exe` must be recognised as absolute even
      // though Node's default `isAbsolute` follows the host OS (which breaks the
      // win32 detection path when running on posix hosts / under test).
      const isAbsolutePath = process.platform === 'win32'
        ? pathWin32.isAbsolute(command)
        : pathPosix.isAbsolute(command);
      if (!isAbsolutePath && command !== config.command) {
        result.error = 'Invalid CLI command';
        resolve(result);
        return;
      }
      try {
        // Build the version check arguments
        const args = argsOverride ?? config.versionFlag.split(' ');

        // Extend PATH to include common CLI installation directories
        // This is needed for packaged Electron apps where PATH may be limited
        const spawnOptions = buildCliSpawnOptions(process.env);
        const commandForSpawn = process.platform === 'win32' && isAbsolutePath && spawnOptions.shell
          ? quoteWindowsShellCommand(command)
          : command;

        logger.debug('Checking command', {
          command,
          args: args.join(' '),
          shell: spawnOptions.shell,
        });

        const proc = spawn(commandForSpawn, args, {
          timeout: 5000,
          ...spawnOptions,
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
            logger.debug('CLI detected', { command, version: result.version });
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
   * Finds every copy of a CLI in all known search directories and reports
   * their versions.  Used to detect "shadow" installs where e.g. a stale
   * Homebrew-npm copy at `/opt/homebrew/bin/<cli>` sits alongside a newer
   * nvm install and silently gets picked up because it appears first in
   * PATH.
   *
   * Walks the same list of directories as `getCliAdditionalPaths()` plus
   * the real `$PATH`, dedupes by realpath (symlinks resolving to the same
   * file count as one install), and runs each copy with its version flag.
   */
  async scanAllCliInstalls(type: CliType): Promise<CliInstall[]> {
    const config = CLI_REGISTRY[type];
    if (!config) {
      return [];
    }

    const cmd = config.command;
    const searchDirs = [
      ...getCliAdditionalPaths(process.env, process.platform),
      ...(process.env['PATH'] || '').split(process.platform === 'win32' ? ';' : ':'),
    ].filter(Boolean);

    // On Windows a CLI may exist only as `<cmd>.exe` — Claude Code's native
    // installer drops `claude.exe` in `~/.local/bin` with NO extensionless
    // shim, so probing the bare `<cmd>` alone (which works for npm CLIs like
    // codex, whose `.cmd`/`.ps1` shims ship alongside an extensionless launcher)
    // finds nothing and the CLI Health tab falsely reports "not installed".
    // Probe in the same executable-extension priority Windows uses. npm global
    // bins often include an extensionless POSIX shell stub beside the real
    // `.cmd`; picking the stub first makes health/updater prefer stale NVM
    // copies that happen not to live under "Program Files".
    const candidateNames = process.platform === 'win32'
      ? WINDOWS_EXECUTABLE_EXTENSIONS.map((ext) => `${cmd}${ext}`)
      : [cmd];

    const seenReal = new Set<string>();
    const candidates: string[] = [];
    for (const dir of searchDirs) {
      // One install per directory: take the first matching name (the copy the
      // OS would actually run), so an npm shim trio isn't reported as 3 installs.
      let candidate: string | undefined;
      for (const name of candidateNames) {
        const probe = `${dir}/${name}`;
        if (existsSync(probe)) {
          candidate = probe;
          break;
        }
      }
      if (!candidate) continue;
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        real = candidate;
      }
      if (seenReal.has(real)) continue;
      seenReal.add(real);
      candidates.push(candidate);
    }

    const results = await Promise.all(
      candidates.map(async (path): Promise<CliInstall> => {
        const info = await this.checkCommand(path, config);
        if (!info.installed && existsSync(path)) {
          logger.warn('CLI scan version probe failed, but binary exists on disk — preserving install order', {
            cli: type,
            path,
            error: info.error,
          });
          return {
            path,
            installed: true,
            error: info.error,
          };
        }
        return {
          path,
          version: info.version,
          installed: info.installed,
          error: info.error,
        };
      }),
    );

    return results.filter((r) => r.installed);
  }

  /**
   * Checks a CLI for shadow installs — multiple copies at different PATH
   * locations, reporting different versions.  Returns null if there is no
   * shadow (0 or 1 installs, or all installs report the same version).
   */
  async detectShadowInstalls(type: CliType): Promise<CliShadowReport | null> {
    const installs = await this.scanAllCliInstalls(type);
    if (installs.length < 2) return null;

    const versions = new Set(installs.map((i) => i.version ?? 'unknown'));
    if (versions.size < 2) return null;

    return {
      cli: type,
      installs,
      activePath: installs[0]?.path,
      activeVersion: installs[0]?.version,
    };
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
