import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  readFile: vi.fn(),
  execFile: vi.fn(),
  getServers: vi.fn(),
  getTools: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  access: mocks.access,
  readFile: mocks.readFile,
  default: {
    access: mocks.access,
    readFile: mocks.readFile,
  },
}));

vi.mock('child_process', () => ({
  execFile: mocks.execFile,
  default: {
    execFile: mocks.execFile,
  },
}));

vi.mock('../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    getServers: mocks.getServers,
    getTools: mocks.getTools,
  }),
}));

import { BrowserAutomationHealthService } from './browser-automation-health';

describe('BrowserAutomationHealthService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    BrowserAutomationHealthService._resetForTesting();

    mocks.access.mockResolvedValue(undefined);
    mocks.execFile.mockImplementation((...args: unknown[]) => {
      const callback = [...args].reverse().find((arg) => typeof arg === 'function') as
        | ((error: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      callback?.(null, 'v20.0.0', '');
      return { kill: vi.fn() };
    });
    mocks.getServers.mockReturnValue([]);
    mocks.getTools.mockReturnValue([]);
  });

  afterEach(() => {
    BrowserAutomationHealthService._resetForTesting();
    vi.useRealTimers();
  });

  it('treats detected Claude browser MCP config as ready without requiring in-app tools', async () => {
    mocks.readFile.mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('.claude.json')) {
        return JSON.stringify({
          mcpServers: {
            'chrome-devtools': {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest'],
            },
          },
        });
      }
      throw new Error('missing');
    });

    const report = await BrowserAutomationHealthService.getInstance().diagnose();

    expect(report.status).toBe('ready');
    expect(report.configDetected).toBe(true);
    expect(report.inAppConnected).toBe(false);
    expect(report.inAppToolCount).toBe(0);
    expect(report.warnings).not.toContain(
      'No browser automation MCP configuration was found in Claude settings or the in-app MCP registry.',
    );
  });

  it('reports missing when browser automation is not configured anywhere', async () => {
    mocks.readFile.mockRejectedValue(new Error('missing'));

    const report = await BrowserAutomationHealthService.getInstance().diagnose();

    expect(report.status).toBe('missing');
    expect(report.configDetected).toBe(false);
    expect(report.inAppConfigured).toBe(false);
    expect(report.warnings).toContain(
      'No browser automation MCP configuration was found in Claude settings or the in-app MCP registry.',
    );
  });

  it('keeps configured but disconnected in-app browser MCP degraded', async () => {
    mocks.readFile.mockRejectedValue(new Error('missing'));
    mocks.getServers.mockReturnValue([
      {
        id: 'chrome-devtools',
        name: 'Chrome DevTools',
        description: 'Browser automation through Chrome DevTools MCP',
        status: 'disconnected',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest'],
      },
    ]);

    const report = await BrowserAutomationHealthService.getInstance().diagnose();

    expect(report.status).toBe('partial');
    expect(report.inAppConfigured).toBe(true);
    expect(report.inAppConnected).toBe(false);
    expect(report.warnings).toContain(
      'A browser automation server is configured in-app but is not currently connected.',
    );
  });
});
