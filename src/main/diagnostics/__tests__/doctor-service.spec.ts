import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '../../../shared/types/diagnostics.types';

const {
  diagnoseProvider,
  getProviderConfigs,
} = vi.hoisted(() => ({
  diagnoseProvider: vi.fn(),
  getProviderConfigs: vi.fn(),
}));

vi.mock('../../commands/command-manager', () => ({
  getCommandManager: () => ({
    getAllCommandsSnapshot: vi.fn(),
  }),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      broadRootFileThreshold: 100,
      commandDiagnosticsAvailable: true,
    }),
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../bootstrap/capability-probe', () => ({
  getCapabilityProbe: () => ({
    getLastReport: vi.fn(() => null),
    run: vi.fn(async () => ({
      status: 'ready',
      generatedAt: 1,
      checks: [],
    })),
  }),
}));

vi.mock('../../cli/cli-detection', () => ({
  CLI_REGISTRY: {},
  SUPPORTED_CLIS: [],
  getCliDetectionService: () => ({
    detectAll: vi.fn(async () => ({ detected: [], available: [] })),
    scanAllCliInstalls: vi.fn(async () => []),
  }),
}));

vi.mock('../../cli/cli-update-service', () => ({
  getCliUpdateService: () => ({
    getUpdatePlan: vi.fn(),
  }),
}));

vi.mock('../../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: vi.fn(async () => ({
      status: 'ready',
      checkedAt: 1,
      runtimeAvailable: false,
      nodeAvailable: false,
      inAppConfigured: false,
      inAppConnected: false,
      inAppToolCount: 0,
      configDetected: false,
      browserToolNames: [],
      warnings: [],
      suggestions: [],
    })),
  }),
}));

vi.mock('../../providers/provider-doctor', () => ({
  getProviderDoctor: () => ({
    diagnose: diagnoseProvider,
  }),
}));

vi.mock('../../providers/provider-instance-manager', () => ({
  getProviderInstanceManager: () => ({
    getAllConfigs: getProviderConfigs,
  }),
}));

vi.mock('../skill-diagnostics-service', () => ({
  getSkillDiagnosticsService: () => ({
    collect: vi.fn(async () => []),
  }),
}));

vi.mock('../instruction-diagnostics-service', () => ({
  getInstructionDiagnosticsService: () => ({
    collect: vi.fn(async () => []),
  }),
}));

import { DoctorService } from '../doctor-service';

describe('DoctorService', () => {
  beforeEach(() => {
    DoctorService._resetForTesting();
    diagnoseProvider.mockReset();
    diagnoseProvider.mockImplementation(async (provider: string) => ({
      provider,
      overall: 'healthy',
      probes: [],
      recommendations: [],
      repairActions: [],
      timestamp: 1,
    }));
    getProviderConfigs.mockReset();
    getProviderConfigs.mockReturnValue([]);
  });

  it('maps startup checks to Doctor sections', () => {
    const service = new DoctorService();

    expect(service.resolveSectionForStartupCheck('provider.codex')).toBe('provider-health');
    expect(service.resolveSectionForStartupCheck('subsystem.browser-automation')).toBe('browser-automation');
    expect(service.resolveSectionForStartupCheck('native.sqlite')).toBe('startup-capabilities');
  });

  it('builds deterministic section summaries', () => {
    const service = new DoctorService();
    const summaries = service.buildSectionSummaries({
      schemaVersion: 1,
      generatedAt: 1,
      startupCapabilities: {
        status: 'degraded',
        generatedAt: 1,
        checks: [
          {
            id: 'provider.codex',
            label: 'Codex',
            category: 'provider',
            status: 'degraded',
            critical: false,
            summary: 'missing',
          },
        ],
      },
      providerDiagnoses: [],
      cliHealth: {
        installs: [],
        updatePlans: [{ cli: 'claude', displayName: 'Claude', supported: true }],
        generatedAt: 1,
      },
      browserAutomation: null,
      commandDiagnostics: {
        available: true,
        diagnostics: [],
        scanDirs: [],
        generatedAt: 1,
      },
      skillDiagnostics: [{ code: 'missing-file', severity: 'error', message: 'missing' }],
      instructionDiagnostics: [],
    } satisfies Omit<DoctorReport, 'sections'>);

    expect(summaries.map((summary) => summary.id)).toEqual([
      'startup-capabilities',
      'provider-health',
      'cli-health',
      'browser-automation',
      'commands-and-skills',
      'instructions',
      'operator-artifacts',
    ]);
    expect(summaries.find((summary) => summary.id === 'cli-health')?.severity).toBe('info');
    expect(summaries.find((summary) => summary.id === 'commands-and-skills')?.severity).toBe('error');
  });

  it('adds bridge-backed plugin providers to the doctor report provider diagnoses', async () => {
    getProviderConfigs.mockReturnValue([
      { type: 'claude-cli', name: 'Claude Code', enabled: true },
      { type: 'plugin:acme-cli', name: 'Acme CLI', enabled: true },
    ]);

    const report = await DoctorService.getInstance().getReport({ force: true });

    expect(diagnoseProvider).toHaveBeenCalledWith('plugin:acme-cli');
    expect(report.providerDiagnoses.map((diagnosis) => diagnosis.provider))
      .toContain('plugin:acme-cli');
  });
});
