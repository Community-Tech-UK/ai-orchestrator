import { describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '../../../shared/types/diagnostics.types';

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

import { DoctorService } from '../doctor-service';

describe('DoctorService', () => {
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
});
