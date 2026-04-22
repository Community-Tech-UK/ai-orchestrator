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
});
