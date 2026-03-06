import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
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

function readClaudeSettingsSources(): BrowserAutomationHealthSource[] {
  return resolveClaudeSettingsPaths().map((filePath) => {
    if (!fs.existsSync(filePath)) {
      return {
        path: filePath,
        detected: false,
        serverNames: [],
      };
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ClaudeSettingsFile;
      const mcpServers = parsed.mcpServers || {};
      const serverNames = Object.entries(mcpServers)
        .filter(([id, server]) =>
          stringContainsBrowserKeyword(id) ||
          stringContainsBrowserKeyword(server.command) ||
          stringContainsBrowserKeyword(server.url) ||
          (server.args || []).some((arg) => stringContainsBrowserKeyword(arg)),
        )
        .map(([id]) => id);

      return {
        path: filePath,
        detected: serverNames.length > 0,
        serverNames,
      };
    } catch {
      return {
        path: filePath,
        detected: false,
        serverNames: [],
      };
    }
  });
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command)) {
    return fs.existsSync(command);
  }

  try {
    execFileSync('which', [command], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
}

function detectBrowserRuntime(): { available: boolean; command?: string } {
  for (const command of BROWSER_COMMANDS) {
    if (commandExists(command)) {
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

function detectNodeAvailability(): boolean {
  try {
    execFileSync(process.execPath, ['--version'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return true;
  } catch {
    return false;
  }
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

  private constructor() {
    // Singleton
  }

  diagnose(): BrowserAutomationHealthReport {
    const checkedAt = Date.now();
    const runtime = detectBrowserRuntime();
    const nodeAvailable = detectNodeAvailability();
    const configSources = readClaudeSettingsSources();
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

    return {
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
  }
}

export function getBrowserAutomationHealthService(): BrowserAutomationHealthService {
  return BrowserAutomationHealthService.getInstance();
}
