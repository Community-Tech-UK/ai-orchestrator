import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  BrowserHealthService,
  setBrowserGatewayMcpBridgeAvailabilityProvider,
} from './browser-health-service';

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
      codex: 'unconfigured',
      gemini: 'unconfigured_adapter_injection_missing',
    });
    expect(report.rawLegacyAutomation.status).toBe('ready');
    expect(report.rawLegacyAutomation.surface).toBe('legacy_raw_browser_automation');
    expect(report.providerCapabilityDetails).toMatchObject({
      codex: {
        status: 'unconfigured',
        available: false,
        message: expect.stringContaining('MCP bridge is unavailable'),
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
      codex: 'available_via_mcp',
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
      codex: {
        status: 'available_via_mcp',
        available: true,
        message: expect.stringContaining('injected MCP config'),
      },
    });
  });

  it('uses the latest default MCP bridge availability provider for long-lived services', async () => {
    setBrowserGatewayMcpBridgeAvailabilityProvider(() => false);
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
      chromeRuntimeDetector: async () => ({
        available: true,
        command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }),
      now: () => 5,
    });
    setBrowserGatewayMcpBridgeAvailabilityProvider(() => true);

    const report = await service.diagnose();

    expect(report.mcpBridge.available).toBe(true);
    expect(report.status).toBe('ready');
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

  it('reports connected remote extension relay nodes', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-1',
      name: 'Windows PC',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
          socketPath: 'C:/Users/James/.orchestrator/browser-gateway/extension-relay.sock',
          lastExtensionContactAt: 5_500,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    }];
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
      workerNodeRegistry: { getAllNodes: () => nodes },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 6_000,
    });

    const report = await service.diagnose();

    expect(report.remoteExtensions).toEqual({
      total: 1,
      ready: 1,
      silent: 0,
      nodes: [{
        nodeId: 'node-1',
        nodeName: 'Windows PC',
        enabled: true,
        running: true,
        silent: false,
        lastContactAt: 5_500,
        contactAgeMs: 500,
        queue: {
          queuedCount: 0,
          inFlightCount: 0,
          waitingPollerCount: 0,
        },
        contactGaps: {
          gapCount: 0,
          longestGapMs: 0,
        },
        serviceWorkerRestarts: 0,
        registration: undefined,
        lastRegistrationCheckAt: undefined,
      }],
    });
  });

  it('treats listening relays without recent extension contact as silent', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-1',
      name: 'Windows PC',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
          registration: 'ok',
          lastExtensionContactAt: 1_000,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    }];
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
      workerNodeRegistry: { getAllNodes: () => nodes },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 100_001,
    });

    const report = await service.diagnose();

    expect(report.remoteExtensions).toMatchObject({
      total: 1,
      ready: 0,
      silent: 1,
      nodes: [{
        nodeId: 'node-1',
        enabled: true,
        running: true,
        silent: true,
        lastContactAt: 1_000,
        registration: 'ok',
      }],
    });
  });

  it('uses coordinator-observed extension contact for older worker summaries', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-1',
      name: 'Windows PC',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    }];
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
      workerNodeRegistry: { getAllNodes: () => nodes },
      extensionContactState: {
        getLastExtensionContactAt: () => 9_500,
        isExtensionContactFresh: () => true,
        describeExtensionContact: (nodeId) => ({
          nodeId,
          lastContactAt: 9_500,
          silent: false,
        }),
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 10_000,
    });

    const report = await service.diagnose();

    expect(report.remoteExtensions).toMatchObject({
      total: 1,
      ready: 1,
      silent: 0,
      nodes: [{
        nodeId: 'node-1',
        lastContactAt: 9_500,
        silent: false,
      }],
    });
  });

  it('reports contested registration without marking a fresh relay silent', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-1',
      name: 'Windows PC',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
          registration: 'contested',
          lastRegistrationCheckAt: 99_000,
          lastExtensionContactAt: 95_000,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    }];
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
      workerNodeRegistry: { getAllNodes: () => nodes },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 100_000,
    });

    const report = await service.diagnose();

    expect(report.remoteExtensions).toMatchObject({
      total: 1,
      ready: 1,
      silent: 0,
      nodes: [{
        nodeId: 'node-1',
        silent: false,
        registration: 'contested',
        lastRegistrationCheckAt: 99_000,
      }],
    });
  });

  it('counts service-worker restarts when extension start time changes', async () => {
    const node: WorkerNodeInfo = {
      id: 'node-1',
      name: 'Windows PC',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'win32',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasExtensionRelay: true,
        extensionRelay: {
          enabled: true,
          running: true,
          lastExtensionContactAt: 10_000,
          extensionReloadedAt: 9_000,
        },
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
    };
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
      workerNodeRegistry: { getAllNodes: () => [node] },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => 10_000,
    });

    expect((await service.diagnose()).remoteExtensions.nodes[0].serviceWorkerRestarts).toBe(0);
    node.capabilities.extensionRelay!.extensionReloadedAt = 9_500;
    expect((await service.diagnose()).remoteExtensions.nodes[0].serviceWorkerRestarts).toBe(1);
  });
});
