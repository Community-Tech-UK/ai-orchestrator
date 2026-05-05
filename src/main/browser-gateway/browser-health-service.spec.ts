import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@contracts/types/browser';
import { BrowserHealthService } from './browser-health-service';

describe('BrowserHealthService', () => {
  it('does not treat raw Chrome DevTools MCP readiness as managed Browser Gateway readiness', async () => {
    const profiles: BrowserProfile[] = [
      {
        id: 'profile-1',
        label: 'Running',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-2',
        label: 'Stopped',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'stopped',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const service = new BrowserHealthService({
      profileStore: { listProfiles: () => profiles },
      rawAutomationHealthService: {
        diagnose: async () => ({
          status: 'ready',
          checkedAt: 1,
          runtimeAvailable: true,
          runtimeCommand: 'chrome',
          nodeAvailable: true,
          inAppConfigured: true,
          inAppConnected: true,
          inAppToolCount: 2,
          configDetected: true,
          configSources: [],
          browserToolNames: ['browser_snapshot'],
          warnings: [],
          suggestions: [],
          surface: 'legacy_raw_browser_automation',
        }),
      },
      mcpBridgeAvailable: () => false,
      chromeRuntimeDetector: async () => ({
        available: true,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
      now: () => 2,
    });

    const report = await service.diagnose();

    expect(report.status).toBe('partial');
    expect(report.chromeRuntime.available).toBe(true);
    expect(report.managedProfiles.total).toBe(2);
    expect(report.managedProfiles.running).toBe(1);
    expect(report.managedProfiles).toMatchObject({
      locked: 0,
      errors: 0,
    });
    expect(report.mcpBridge.available).toBe(false);
    expect(report.providerCapabilities).toEqual({
      claude: 'legacy_chrome_disabled',
      copilot: 'unconfigured',
      codex: 'unavailable_exec_mode',
      gemini: 'unconfigured_adapter_injection_missing',
    });
    expect(report.rawLegacyAutomation.status).toBe('ready');
    expect(report.rawLegacyAutomation.surface).toBe('legacy_raw_browser_automation');
    expect(report.providerCapabilityDetails).toMatchObject({
      codex: {
        status: 'unavailable_exec_mode',
        available: false,
        message: expect.stringContaining('exec-mode'),
      },
      gemini: {
        status: 'unconfigured_adapter_injection_missing',
        available: false,
        message: expect.stringContaining('adapter MCP injection'),
      },
    });
    expect(report.warnings).toContain(
      'Browser Gateway MCP bridge is unavailable for provider child processes.',
    );
  });

  it('reports provider Browser Gateway availability when the MCP bridge is online', async () => {
    const service = new BrowserHealthService({
      profileStore: { listProfiles: () => [] },
      rawAutomationHealthService: {
        diagnose: async () => ({
          status: 'missing',
          checkedAt: 1,
          runtimeAvailable: false,
          nodeAvailable: true,
          inAppConfigured: false,
          inAppConnected: false,
          inAppToolCount: 0,
          configDetected: false,
          configSources: [],
          browserToolNames: [],
          warnings: [],
          suggestions: [],
          surface: 'legacy_raw_browser_automation',
        }),
      },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({
        available: true,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
      now: () => 3,
    });

    const report = await service.diagnose();

    expect(report.status).toBe('ready');
    expect(report.providerCapabilities).toMatchObject({
      claude: 'available_via_mcp',
      copilot: 'available_via_acp_mcp',
      codex: 'unavailable_exec_mode',
      gemini: 'unconfigured_adapter_injection_missing',
    });
    expect(report.providerCapabilityDetails).toMatchObject({
      claude: {
        available: true,
        message: expect.stringContaining('Browser Gateway MCP'),
      },
      copilot: {
        available: true,
        message: expect.stringContaining('ACP MCP'),
      },
    });
  });

  it('reports locked and errored profile counts in health output', async () => {
    const profiles: BrowserProfile[] = [
      {
        id: 'profile-locked',
        label: 'Locked',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'locked',
        createdAt: 1,
        updatedAt: 1,
      },
      {
        id: 'profile-error',
        label: 'Error',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'error',
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    const service = new BrowserHealthService({
      profileStore: { listProfiles: () => profiles },
      rawAutomationHealthService: {
        diagnose: async () => ({
          status: 'missing',
          checkedAt: 1,
          runtimeAvailable: false,
          nodeAvailable: true,
          inAppConfigured: false,
          inAppConnected: false,
          inAppToolCount: 0,
          configDetected: false,
          configSources: [],
          browserToolNames: [],
          warnings: [],
          suggestions: [],
          surface: 'legacy_raw_browser_automation',
        }),
      },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 4,
    });

    const report = await service.diagnose();

    expect(report.managedProfiles).toMatchObject({
      total: 2,
      running: 0,
      locked: 1,
      errors: 1,
    });
    expect(report.warnings).toContain(
      '1 Browser Gateway profile is locked by another Chrome process.',
    );
    expect(report.warnings).toContain(
      '1 Browser Gateway profile is in an error state.',
    );
  });
});
