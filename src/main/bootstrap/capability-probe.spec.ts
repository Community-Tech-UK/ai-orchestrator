import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectAll: vi.fn(),
  diagnose: vi.fn(),
  getRawDb: vi.fn(),
  remoteConfig: vi.fn(),
  browserDiagnose: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../cli/cli-detection', () => ({
  getCliDetectionService: () => ({
    detectAll: mocks.detectAll,
  }),
}));

vi.mock('../providers/provider-doctor', () => ({
  getProviderDoctor: () => ({
    diagnose: mocks.diagnose,
  }),
}));

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getRawDb: mocks.getRawDb,
  }),
}));

vi.mock('../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => mocks.remoteConfig(),
}));

vi.mock('../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: mocks.browserDiagnose,
  }),
}));

import { CapabilityProbe } from './capability-probe';

describe('CapabilityProbe', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.getRawDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ ok: 1 })),
      })),
    });

    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'gemini' },
        { name: 'copilot' },
        { name: 'cursor' },
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockResolvedValue({
      overall: 'healthy',
      probes: [],
      recommendations: [],
      provider: 'claude-cli',
      timestamp: Date.now(),
    });

    mocks.remoteConfig.mockReturnValue({
      enabled: false,
      serverHost: '127.0.0.1',
      serverPort: 4878,
      namespace: 'default',
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
    });

    mocks.browserDiagnose.mockResolvedValue({
      status: 'ready',
      checkedAt: Date.now(),
      runtimeAvailable: true,
      nodeAvailable: true,
      inAppConfigured: true,
      inAppConnected: true,
      inAppToolCount: 3,
      configDetected: true,
      configSources: [],
      browserToolNames: ['browser_navigate'],
      warnings: [],
      suggestions: [],
    });
  });

  it('reports ready when core checks pass and at least one provider is available', async () => {
    const probe = new CapabilityProbe();

    const report = await probe.run();

    expect(report.status).toBe('ready');
    expect(report.checks.find((check) => check.id === 'provider.any')).toMatchObject({
      status: 'ready',
      critical: true,
    });
    expect(report.checks.find((check) => check.id === 'native.sqlite')).toMatchObject({
      status: 'ready',
    });
  });

  it('reports failed when sqlite is unavailable and no provider CLI is available', async () => {
    mocks.getRawDb.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => {
          throw new Error('sqlite load failed');
        }),
      })),
    });
    mocks.detectAll.mockResolvedValue({
      available: [],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    const probe = new CapabilityProbe();
    const report = await probe.run();

    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'provider.any')).toMatchObject({
      status: 'unavailable',
    });
    expect(report.checks.find((check) => check.id === 'native.sqlite')).toMatchObject({
      status: 'unavailable',
    });
  });

  it('treats unconfigured browser automation as disabled instead of degraded', async () => {
    mocks.browserDiagnose.mockResolvedValue({
      status: 'partial',
      checkedAt: Date.now(),
      runtimeAvailable: true,
      nodeAvailable: true,
      inAppConfigured: false,
      inAppConnected: false,
      inAppToolCount: 0,
      configDetected: false,
      configSources: [],
      browserToolNames: [],
      warnings: ['No browser automation MCP configuration was found in Claude settings or the in-app MCP registry.'],
      suggestions: ['Add the Chrome DevTools MCP server from the MCP page.'],
    });

    const probe = new CapabilityProbe();
    const report = await probe.run();

    expect(report.status).toBe('ready');
    expect(report.checks.find((check) => check.id === 'subsystem.browser-automation')).toMatchObject({
      status: 'disabled',
      summary: 'Browser automation is not configured.',
    });
  });

  it('keeps browser automation degraded when it is configured but not healthy', async () => {
    mocks.browserDiagnose.mockResolvedValue({
      status: 'partial',
      checkedAt: Date.now(),
      runtimeAvailable: true,
      nodeAvailable: true,
      inAppConfigured: true,
      inAppConnected: false,
      inAppToolCount: 0,
      configDetected: true,
      configSources: [
        {
          path: '/Users/test/.claude/settings.json',
          detected: true,
          serverNames: ['chrome-devtools'],
        },
      ],
      browserToolNames: [],
      warnings: ['A browser automation server is configured in-app but is not currently connected.'],
      suggestions: ['Connect the browser MCP server from the MCP page and rerun the health check.'],
    });

    const probe = new CapabilityProbe();
    const report = await probe.run();

    expect(report.status).toBe('degraded');
    expect(report.checks.find((check) => check.id === 'subsystem.browser-automation')).toMatchObject({
      status: 'degraded',
      summary: 'A browser automation server is configured in-app but is not currently connected.',
    });
  });

  it('treats a provider as installed when the doctor\'s cli_installed probe passes, even if detection missed it', async () => {
    // Reproduce the bug from app.log timestamp 1778679400184: CliDetection
    // missed cursor (its `--version` spawn timed out under fork pressure),
    // but ProviderDoctor's `which cursor-agent` succeeded in the same run.
    // The probe should trust the lighter `which` probe rather than emitting
    // "Cursor CLI is not available on PATH" for a CLI that is on PATH.
    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'gemini' },
        { name: 'copilot' },
        // cursor intentionally absent — detection thinks it's not installed
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockImplementation(async (providerKey: string) => ({
      overall: 'healthy' as const,
      probes: [
        {
          name: 'cli_installed',
          status: 'pass' as const,
          message: `${providerKey} found in PATH`,
          latencyMs: 1,
        },
      ],
      recommendations: [],
      provider: providerKey,
      timestamp: Date.now(),
    }));

    const probe = new CapabilityProbe();
    const report = await probe.run();

    const cursorCheck = report.checks.find((check) => check.id === 'provider.cursor');
    expect(cursorCheck).toBeDefined();
    expect(cursorCheck?.status).toBe('ready');
    expect(cursorCheck?.summary).not.toMatch(/not available on PATH/i);
  });

  it('still reports the provider as not available on PATH when both detection and the cli_installed probe fail', async () => {
    mocks.detectAll.mockResolvedValue({
      available: [
        { name: 'claude' },
        { name: 'codex' },
        { name: 'gemini' },
        { name: 'copilot' },
      ],
      detected: [],
      unavailable: [],
      timestamp: new Date(),
    });

    mocks.diagnose.mockImplementation(async (providerKey: string) => ({
      overall: providerKey === 'cursor' ? 'unhealthy' as const : 'healthy' as const,
      probes: providerKey === 'cursor'
        ? [{
            name: 'cli_installed',
            status: 'fail' as const,
            message: 'cursor-agent not found in PATH',
            latencyMs: 1,
          }]
        : [{
            name: 'cli_installed',
            status: 'pass' as const,
            message: `${providerKey} found in PATH`,
            latencyMs: 1,
          }],
      recommendations: providerKey === 'cursor' ? ['Install Cursor and ensure `cursor-agent` is on PATH'] : [],
      provider: providerKey,
      timestamp: Date.now(),
    }));

    const probe = new CapabilityProbe();
    const report = await probe.run();

    const cursorCheck = report.checks.find((check) => check.id === 'provider.cursor');
    expect(cursorCheck).toMatchObject({
      status: 'degraded',
      summary: 'Cursor CLI is not available on PATH.',
    });
  });
});
