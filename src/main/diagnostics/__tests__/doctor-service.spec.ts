import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '../../../shared/types/diagnostics.types';

const {
  diagnoseProvider,
  getProviderConfigs,
  capabilityGetLastReport,
  capabilityRun,
} = vi.hoisted(() => ({
  diagnoseProvider: vi.fn(),
  getProviderConfigs: vi.fn(),
  capabilityGetLastReport: vi.fn(),
  capabilityRun: vi.fn(),
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
    getLastReport: capabilityGetLastReport,
    run: capabilityRun,
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
    capabilityGetLastReport.mockReset();
    capabilityGetLastReport.mockReturnValue(null);
    capabilityRun.mockReset();
    capabilityRun.mockResolvedValue({ status: 'ready', generatedAt: 1, checks: [] });
  });

  it('re-probes startup capabilities on a forced report instead of replaying the boot snapshot', async () => {
    // Regression: pressing Doctor "Refresh" after fixing something outside the
    // app (e.g. `claude auth login`) kept showing the boot-time degraded
    // report until the app was restarted.
    const staleReport = {
      status: 'degraded' as const,
      generatedAt: 1,
      checks: [
        {
          id: 'provider.claude',
          label: 'Claude Code CLI',
          category: 'provider' as const,
          status: 'degraded' as const,
          critical: false,
          summary: 'Unable to read Claude CLI auth status',
        },
      ],
    };
    capabilityGetLastReport.mockReturnValue(staleReport);
    capabilityRun.mockResolvedValue({ status: 'ready', generatedAt: 2, checks: [] });

    const service = new DoctorService();
    const report = await service.getReport({ force: true });

    expect(capabilityRun).toHaveBeenCalledWith({ force: true });
    expect(report.startupCapabilities).toMatchObject({ status: 'ready', generatedAt: 2 });
  });

  it('reuses the cached startup report for an unforced report', async () => {
    const bootReport = { status: 'ready' as const, generatedAt: 1, checks: [] };
    capabilityGetLastReport.mockReturnValue(bootReport);

    const service = new DoctorService();
    const report = await service.getReport();

    expect(capabilityRun).not.toHaveBeenCalled();
    expect(report.startupCapabilities).toBe(bootReport);
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
      loopRecipeDiagnostics: [],
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

  it('escalates the commands-and-skills section on a malformed loop recipe (Fable WS6)', () => {
    const service = new DoctorService();
    const base: Omit<DoctorReport, 'sections'> = {
      schemaVersion: 1,
      generatedAt: 1,
      startupCapabilities: null,
      providerDiagnoses: [],
      cliHealth: { installs: [], updatePlans: [], generatedAt: 1 },
      browserAutomation: null,
      commandDiagnostics: { available: true, diagnostics: [], scanDirs: [], generatedAt: 1 },
      skillDiagnostics: [],
      instructionDiagnostics: [],
      loopRecipeDiagnostics: [
        { recipe: 'coding', kind: 'malformed-pack', severity: 'error', message: 'bad json' },
      ],
    };
    const section = service.buildSectionSummaries(base).find((s) => s.id === 'commands-and-skills');
    expect(section?.severity).toBe('error');
    expect(section?.headline).toContain('recipe diagnostic');

    // A user-override alone is informational, not an error/warning.
    const overrideOnly = service.buildSectionSummaries({
      ...base,
      loopRecipeDiagnostics: [
        { recipe: 'coding', kind: 'user-override', severity: 'info', message: 'user pack overrides built-in' },
      ],
    }).find((s) => s.id === 'commands-and-skills');
    expect(overrideOnly?.severity).toBe('ok');
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
