/**
 * Debug Commands - Debug subcommands for troubleshooting (13.2)
 *
 * Provides diagnostic commands for debugging various subsystems.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

/**
 * Debug target types
 */
export type DebugTarget =
  | 'agent'
  | 'config'
  | 'file'
  | 'lsp'
  | 'mcp'
  | 'instance'
  | 'memory'
  | 'process'
  | 'system';

/**
 * Debug result
 */
export interface DebugResult {
  target: DebugTarget;
  timestamp: number;
  success: boolean;
  data: Record<string, unknown>;
  errors?: string[];
  warnings?: string[];
}

/**
 * System information
 */
export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  appVersion: string;
  cpus: number;
  totalMemory: number;
  freeMemory: number;
  uptime: number;
  homedir: string;
  tmpdir: string;
  userData: string;
}

/**
 * Memory snapshot
 */
export interface MemorySnapshot {
  timestamp: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  rss: number;
}

/**
 * Debug Commands Manager
 */
export class DebugCommandsManager {
  private memorySnapshots: MemorySnapshot[] = [];
  private maxSnapshots: number = 100;

  /**
   * Debug agent configuration
   */
  async debugAgent(agentId?: string): Promise<DebugResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // Import agent types dynamically to avoid circular deps
      const { BUILTIN_AGENTS, getAgentById } = await import('../../shared/types/agent.types');

      const data: Record<string, unknown> = {
        builtinAgents: BUILTIN_AGENTS.map((a) => ({
          id: a.id,
          name: a.name,
          mode: a.mode,
          permissions: a.permissions,
        })),
      };

      if (agentId) {
        const agent = getAgentById(agentId);
        if (agent) {
          data['requestedAgent'] = agent;
        } else {
          errors.push(`Agent with id '${agentId}' not found`);
        }
      }

      return {
        target: 'agent',
        timestamp: Date.now(),
        success: errors.length === 0,
        data,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: any) {
      return {
        target: 'agent',
        timestamp: Date.now(),
        success: false,
        data: {},
        errors: [error.message],
      };
    }
  }

  /**
   * Debug configuration resolution
   */
  async debugConfig(workingDirectory?: string): Promise<DebugResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const data: Record<string, unknown> = {
        workingDirectory: workingDirectory || process.cwd(),
        envVars: {
          CLAUDE_CONFIG_DIR: process.env['CLAUDE_CONFIG_DIR'],
          XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
          HOME: process.env['HOME'],
        },
        appPaths: {
          userData: app.getPath('userData'),
          appData: app.getPath('appData'),
          temp: app.getPath('temp'),
          logs: app.getPath('logs'),
        },
      };

      // Check for project config
      if (workingDirectory) {
        const projectConfigPath = path.join(workingDirectory, '.claude-orchestrator.json');
        data['projectConfigExists'] = fs.existsSync(projectConfigPath);
        if (data['projectConfigExists']) {
          try {
            data['projectConfig'] = JSON.parse(fs.readFileSync(projectConfigPath, 'utf-8'));
          } catch (e: any) {
            errors.push(`Failed to parse project config: ${e.message}`);
          }
        }
      }

      // Check for user config
      const userConfigPath = path.join(app.getPath('userData'), 'settings.json');
      data['userConfigExists'] = fs.existsSync(userConfigPath);
      if (data['userConfigExists']) {
        try {
          data['userConfig'] = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));
        } catch (e: any) {
          errors.push(`Failed to parse user config: ${e.message}`);
        }
      }

      return {
        target: 'config',
        timestamp: Date.now(),
        success: errors.length === 0,
        data,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: any) {
      return {
        target: 'config',
        timestamp: Date.now(),
        success: false,
        data: {},
        errors: [error.message],
      };
    }
  }

  /**
   * Debug file operations
   */
  async debugFile(filePath: string): Promise<DebugResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const data: Record<string, unknown> = {
        path: filePath,
        absolutePath: path.resolve(filePath),
        exists: fs.existsSync(filePath),
      };

      if (data['exists']) {
        const stats = fs.statSync(filePath);
        data['stats'] = {
          isFile: stats.isFile(),
          isDirectory: stats.isDirectory(),
          isSymbolicLink: stats.isSymbolicLink(),
          size: stats.size,
          mode: stats.mode.toString(8),
          uid: stats.uid,
          gid: stats.gid,
          atime: stats.atime.toISOString(),
          mtime: stats.mtime.toISOString(),
          ctime: stats.ctime.toISOString(),
          birthtime: stats.birthtime.toISOString(),
        };

        // Check permissions
        try {
          fs.accessSync(filePath, fs.constants.R_OK);
          data['readable'] = true;
        } catch {
          data['readable'] = false;
          warnings.push('File is not readable');
        }

        try {
          fs.accessSync(filePath, fs.constants.W_OK);
          data['writable'] = true;
        } catch {
          data['writable'] = false;
        }

        // For text files, get encoding info
        if (stats.isFile() && stats.size < 1024 * 1024) {
          try {
            const buffer = fs.readFileSync(filePath);
            data['encoding'] = this.detectEncoding(buffer);
            data['lineCount'] = buffer.toString('utf-8').split('\n').length;
          } catch (e: any) {
            warnings.push(`Could not read file contents: ${e.message}`);
          }
        }
      } else {
        // Check parent directory
        const parentDir = path.dirname(filePath);
        data['parentExists'] = fs.existsSync(parentDir);
        if (!data['parentExists']) {
          errors.push('Parent directory does not exist');
        }
      }

      return {
        target: 'file',
        timestamp: Date.now(),
        success: errors.length === 0,
        data,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error: any) {
      return {
        target: 'file',
        timestamp: Date.now(),
        success: false,
        data: { path: filePath },
        errors: [error.message],
      };
    }
  }

  /**
   * Detect file encoding from buffer
   */
  private detectEncoding(buffer: Buffer): string {
    // Check for BOM
    if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
      return 'utf-8-bom';
    }
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return 'utf-16-le';
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return 'utf-16-be';
    }

    // Simple heuristic for UTF-8 vs binary
    let nonAscii = 0;
    let nullBytes = 0;
    const sample = Math.min(buffer.length, 8192);

    for (let i = 0; i < sample; i++) {
      if (buffer[i] === 0) nullBytes++;
      if (buffer[i] > 127) nonAscii++;
    }

    if (nullBytes > sample * 0.1) return 'binary';
    if (nonAscii === 0) return 'ascii';
    return 'utf-8';
  }

  /**
   * Debug memory usage
   */
  debugMemory(): DebugResult {
    const memUsage = process.memoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      heapUsed: memUsage.heapUsed,
      heapTotal: memUsage.heapTotal,
      external: memUsage.external,
      arrayBuffers: memUsage.arrayBuffers,
      rss: memUsage.rss,
    };

    this.memorySnapshots.push(snapshot);
    if (this.memorySnapshots.length > this.maxSnapshots) {
      this.memorySnapshots = this.memorySnapshots.slice(-this.maxSnapshots);
    }

    const data: Record<string, unknown> = {
      current: {
        heapUsed: this.formatBytes(snapshot.heapUsed),
        heapTotal: this.formatBytes(snapshot.heapTotal),
        heapUsedPercentage: ((snapshot.heapUsed / snapshot.heapTotal) * 100).toFixed(1) + '%',
        external: this.formatBytes(snapshot.external),
        arrayBuffers: this.formatBytes(snapshot.arrayBuffers),
        rss: this.formatBytes(snapshot.rss),
      },
      raw: snapshot,
      history: {
        snapshotCount: this.memorySnapshots.length,
        oldestSnapshot: this.memorySnapshots[0]?.timestamp,
        newestSnapshot: this.memorySnapshots[this.memorySnapshots.length - 1]?.timestamp,
      },
    };

    // Calculate trends if we have history
    if (this.memorySnapshots.length > 1) {
      const first = this.memorySnapshots[0];
      const last = this.memorySnapshots[this.memorySnapshots.length - 1];
      data['trend'] = {
        heapUsedChange: this.formatBytes(last.heapUsed - first.heapUsed),
        heapUsedChangePercent: (((last.heapUsed - first.heapUsed) / first.heapUsed) * 100).toFixed(1) + '%',
        rssChange: this.formatBytes(last.rss - first.rss),
      };
    }

    const warnings: string[] = [];
    if (snapshot.heapUsed / snapshot.heapTotal > 0.9) {
      warnings.push('Heap usage is above 90%');
    }

    return {
      target: 'memory',
      timestamp: Date.now(),
      success: true,
      data,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Format bytes to human readable
   */
  private formatBytes(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Debug system information
   */
  debugSystem(): DebugResult {
    const systemInfo: SystemInfo = {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.versions.node,
      electronVersion: process.versions.electron,
      appVersion: app.getVersion(),
      cpus: os.cpus().length,
      totalMemory: os.totalmem(),
      freeMemory: os.freemem(),
      uptime: os.uptime(),
      homedir: os.homedir(),
      tmpdir: os.tmpdir(),
      userData: app.getPath('userData'),
    };

    const data: Record<string, unknown> = {
      ...systemInfo,
      totalMemoryFormatted: this.formatBytes(systemInfo.totalMemory),
      freeMemoryFormatted: this.formatBytes(systemInfo.freeMemory),
      memoryUsagePercent: (((systemInfo.totalMemory - systemInfo.freeMemory) / systemInfo.totalMemory) * 100).toFixed(1) + '%',
      uptimeFormatted: this.formatUptime(systemInfo.uptime),
      cpuInfo: os.cpus()[0] ? {
        model: os.cpus()[0].model,
        speed: os.cpus()[0].speed + ' MHz',
      } : null,
      networkInterfaces: Object.keys(os.networkInterfaces()),
    };

    return {
      target: 'system',
      timestamp: Date.now(),
      success: true,
      data,
    };
  }

  /**
   * Format uptime to human readable
   */
  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    return parts.join(' ') || '< 1m';
  }

  /**
   * Debug process information
   */
  debugProcess(): DebugResult {
    const data: Record<string, unknown> = {
      pid: process.pid,
      ppid: process.ppid,
      title: process.title,
      argv: process.argv,
      execPath: process.execPath,
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env['NODE_ENV'],
        PATH: process.env['PATH']?.split(path.delimiter).slice(0, 5),
        SHELL: process.env['SHELL'],
        TERM: process.env['TERM'],
        USER: process.env['USER'],
        HOME: process.env['HOME'],
      },
      versions: process.versions,
      features: {
        inspector: process.features?.inspector,
        debug: process.features?.debug,
      },
      resourceUsage: process.resourceUsage ? process.resourceUsage() : null,
    };

    return {
      target: 'process',
      timestamp: Date.now(),
      success: true,
      data,
    };
  }

  /**
   * Get memory snapshots history
   */
  getMemoryHistory(): MemorySnapshot[] {
    return [...this.memorySnapshots];
  }

  /**
   * Clear memory snapshots
   */
  clearMemoryHistory(): void {
    this.memorySnapshots = [];
  }

  /**
   * Run all debug commands
   */
  async debugAll(workingDirectory?: string): Promise<Record<DebugTarget, DebugResult>> {
    const results: Partial<Record<DebugTarget, DebugResult>> = {};

    results.system = this.debugSystem();
    results.process = this.debugProcess();
    results.memory = this.debugMemory();
    results.agent = await this.debugAgent();
    results.config = await this.debugConfig(workingDirectory);

    return results as Record<DebugTarget, DebugResult>;
  }
}

// Singleton instance
let debugCommandsInstance: DebugCommandsManager | null = null;

export function getDebugCommandsManager(): DebugCommandsManager {
  if (!debugCommandsInstance) {
    debugCommandsInstance = new DebugCommandsManager();
  }
  return debugCommandsInstance;
}
