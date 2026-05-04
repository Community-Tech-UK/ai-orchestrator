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
    expect(report.mcpBridge.available).toBe(false);
    expect(report.providerCapabilities).toEqual({
      claude: 'legacy_chrome_disabled',
      copilot: 'unconfigured',
      codex: 'unavailable_exec_mode',
      gemini: 'unconfigured_adapter_injection_missing',
    });
    expect(report.rawLegacyAutomation.status).toBe('ready');
    expect(report.rawLegacyAutomation.surface).toBe('legacy_raw_browser_automation');
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
  });
});
