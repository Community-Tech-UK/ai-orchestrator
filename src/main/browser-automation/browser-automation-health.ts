import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import type { McpServerConfig, McpTool } from '../../shared/types/mcp.types';
import { getMcpManager } from '../mcp/mcp-manager';

export type BrowserAutomationHealthStatus = 'ready' | 'partial' | 'missing';

export interface BrowserAutomationHealthSource {
  path: string;
  detected: boolean;
  serverNames: string[];
}

export interface BrowserAutomationHealthReport {
  status: BrowserAutomationHealthStatus;
  checkedAt: number;
  lastSuccessfulCheckAt?: number;
  runtimeAvailable: boolean;
  runtimeCommand?: string;
  nodeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  inAppToolCount: number;
  configDetected: boolean;
  configSources: BrowserAutomationHealthSource[];
  browserToolNames: string[];
  warnings: string[];
  suggestions: string[];
}

interface ClaudeSettingsFile {
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
  }>;
}

const KNOWN_BROWSER_KEYWORDS = ['chrome', 'devtools', 'playwright', 'browser', 'puppeteer'];
const BROWSER_COMMANDS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'microsoft-edge',
  'msedge',
];

function stringContainsBrowserKeyword(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.toLowerCase();
  return KNOWN_BROWSER_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function serverLooksLikeBrowserAutomation(server: McpServerConfig): boolean {
  return [
    server.id,
    server.name,
    server.description,
    server.command,
    server.url,
    ...(server.args || []),
  ].some((value) => stringContainsBrowserKeyword(value));
}

function toolLooksLikeBrowserAutomation(tool: McpTool): boolean {
  return stringContainsBrowserKeyword(tool.name) || tool.name.startsWith('browser_');
}

function resolveClaudeSettingsPaths(): string[] {
  const home = process.env['HOME'] || process.env['USERPROFILE'] || '';
  if (!home) {
    return [];
  }

  return [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.config', 'claude', 'settings.json'),
  ];
}

async function readClaudeSettingsSources(): Promise<BrowserAutomationHealthSource[]> {
  const results: BrowserAutomationHealthSource[] = [];
  for (const filePath of resolveClaudeSettingsPaths()) {
    try {
      const content = await fsp.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as ClaudeSettingsFile;
      const mcpServers = parsed.mcpServers || {};
      const serverNames = Object.entries(mcpServers)
        .filter(([id, server]) =>
          stringContainsBrowserKeyword(id) ||
          stringContainsBrowserKeyword(server.command) ||
          stringContainsBrowserKeyword(server.url) ||
          (server.args || []).some((arg) => stringContainsBrowserKeyword(arg)),
        )
        .map(([id]) => id);

      results.push({
        path: filePath,
        detected: serverNames.length > 0,
        serverNames,
      });
    } catch {
      results.push({
        path: filePath,
        detected: false,
        serverNames: [],
      });
    }
  }
  return results;
}

async function commandExists(command: string): Promise<boolean> {
  if (path.isAbsolute(command)) {
    try {
      await fsp.access(command);
      return true;
    } catch {
      return false;
    }
  }

  return new Promise<boolean>((resolve) => {
    const child = execFile('which', [command], {
      encoding: 'utf-8',
      timeout: 3000,
    }, (error) => {
      resolve(!error);
    });
    // Safety timeout in case the process hangs
    setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      resolve(false);
    }, 3500);
  });
}

async function detectBrowserRuntime(): Promise<{ available: boolean; command?: string }> {
  for (const command of BROWSER_COMMANDS) {
    if (await commandExists(command)) {
      return {
        available: true,
        command,
      };
    }
  }

  return {
    available: false,
  };
}

async function detectNodeAvailability(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = execFile(process.execPath, ['--version'], {
      encoding: 'utf-8',
      timeout: 3000,
    }, (error) => {
      resolve(!error);
    });
    setTimeout(() => {
      try { child.kill(); } catch { /* already exited */ }
      resolve(false);
    }, 3500);
  });
}

export class BrowserAutomationHealthService {
  private static instance: BrowserAutomationHealthService | null = null;
  private lastSuccessfulCheckAt?: number;

  static getInstance(): BrowserAutomationHealthService {
    if (!this.instance) {
      this.instance = new BrowserAutomationHealthService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Cached report — avoids repeated sync process spawns on every preflight. */
  private cachedReport: BrowserAutomationHealthReport | null = null;
  private static readonly CACHE_TTL_MS = 60_000; // 1 minute

  private constructor() {
    // Singleton
  }

  async diagnose(): Promise<BrowserAutomationHealthReport> {
    // Return cached report if still fresh — the underlying checks spawn
    // child processes for every browser command which can be slow.
    if (this.cachedReport && (Date.now() - this.cachedReport.checkedAt) < BrowserAutomationHealthService.CACHE_TTL_MS) {
      return this.cachedReport;
    }

    const checkedAt = Date.now();
    const [runtime, nodeAvailable, configSources] = await Promise.all([
      detectBrowserRuntime(),
      detectNodeAvailability(),
      readClaudeSettingsSources(),
    ]);
    const configDetected = configSources.some((source) => source.detected);

    const mcp = getMcpManager();
    const servers = mcp.getServers().filter((server) => serverLooksLikeBrowserAutomation(server));
    const tools = mcp.getTools().filter((tool) => toolLooksLikeBrowserAutomation(tool));
    const inAppConnected = servers.some((server) => server.status === 'connected');

    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!runtime.available) {
      warnings.push('No supported browser runtime was detected on this machine.');
      suggestions.push('Install Chrome, Chromium, or Edge before enabling browser automation.');
    }

    if (!nodeAvailable) {
      warnings.push('Node.js is unavailable, so browser MCP servers launched with npx cannot start.');
      suggestions.push('Install Node.js and verify `node --version` succeeds.');
    }

    if (!configDetected && servers.length === 0) {
      warnings.push('No browser automation MCP configuration was found in Claude settings or the in-app MCP registry.');
      suggestions.push('Add the Chrome DevTools MCP server from the MCP page or via `claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest`.');
    }

    if (servers.length > 0 && !inAppConnected) {
      warnings.push('A browser automation server is configured in-app but is not currently connected.');
      suggestions.push('Connect the browser MCP server from the MCP page and rerun the health check.');
    }

    if (inAppConnected && tools.length === 0) {
      warnings.push('A browser automation server is connected but no browser tools were discovered.');
      suggestions.push('Restart the server from the MCP page and confirm the server exposes browser_* tools.');
    }

    const status: BrowserAutomationHealthStatus =
      runtime.available && nodeAvailable && (configDetected || inAppConnected) && tools.length > 0
        ? 'ready'
        : runtime.available || nodeAvailable || configDetected || servers.length > 0
          ? 'partial'
          : 'missing';

    if (status === 'ready') {
      this.lastSuccessfulCheckAt = checkedAt;
    }

    const report: BrowserAutomationHealthReport = {
      status,
      checkedAt,
      lastSuccessfulCheckAt: this.lastSuccessfulCheckAt,
      runtimeAvailable: runtime.available,
      runtimeCommand: runtime.command,
      nodeAvailable,
      inAppConfigured: servers.length > 0,
      inAppConnected,
      inAppToolCount: tools.length,
      configDetected,
      configSources,
      browserToolNames: tools.map((tool) => tool.name),
      warnings,
      suggestions,
    };

    this.cachedReport = report;
    return report;
  }
}

export function getBrowserAutomationHealthService(): BrowserAutomationHealthService {
  return BrowserAutomationHealthService.getInstance();
}
