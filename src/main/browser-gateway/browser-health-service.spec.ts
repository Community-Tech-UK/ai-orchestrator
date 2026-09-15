import { describe, expect, it } from 'vitest';
import type { BrowserProfile } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import {
  BrowserHealthService,
  setBrowserGatewayMcpBridgeAvailabilityProvider,
} from './browser-health-service';
import { workerAgentTooOldReason } from './browser-worker-agent-skew';
import { makeRelayNode } from './browser-gateway-service.test-helpers';

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
      connectionFlapState: () => ({ stormActive: false, replacesInWindow: 0, windowMs: 300_000 }),
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
        channelState: 'fresh',
        commandsDeliverable: true,
        lastContactAt: 5_500,
        contactAgeMs: 500,
        relayContactAgeMs: 500,
        connectionFlap: { stormActive: false, replacesInWindow: 0, windowMs: 300_000 },
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

  describe('relay_not_forwarding (worker relay sees polls the coordinator never gets)', () => {
    const MINUTE = 60_000;
    function relayNode(relayContactAt: number, connectedAt?: number): WorkerNodeInfo {
      const node = makeRelayNode('node-1', 'windows-pc');
      return {
        ...node,
        ...(connectedAt !== undefined ? { connectedAt } : {}),
        capabilities: {
          ...node.capabilities,
          extensionRelay: { ...node.capabilities.extensionRelay!, lastExtensionContactAt: relayContactAt },
        },
      };
    }
    function contactState(coordinatorPollAt: number | undefined) {
      return {
        getLastExtensionContactAt: () => coordinatorPollAt,
        isExtensionContactFresh: () => false,
        describeExtensionContact: (nodeId: string) => ({ nodeId, silent: true }),
        getContactGapStats: () => ({ gapCount: 0, longestGapMs: 0 }),
      };
    }
    function healthService(node: WorkerNodeInfo, coordinatorPollAt: number | undefined, now: number) {
      return new BrowserHealthService({
        profileStore: { listProfiles: () => [] },
        rawAutomationHealthService: { diagnose: async () => ({ status: 'missing' }) as never },
        workerNodeRegistry: { getAllNodes: () => [node] },
        extensionContactState: contactState(coordinatorPollAt),
        connectionFlapState: () => ({ stormActive: true, replacesInWindow: 11, windowMs: 300_000 }),
        mcpBridgeAvailable: () => true,
        chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
        now: () => now,
      });
    }

    it('reports both clocks, the flap storm, and undeliverable commands for the 2026-09-15 incident', async () => {
      const now = 100 * MINUTE;
      const report = await healthService(relayNode(now - 15_000), now - 67 * MINUTE, now).diagnose();

      expect(report.status).toBe('partial');
      expect(report.remoteExtensions).toMatchObject({ ready: 0, silent: 0 });
      expect(report.remoteExtensions.nodes[0]).toMatchObject({
        channelState: 'relay_not_forwarding',
        silent: false,
        commandsDeliverable: false,
        commandsUndeliverableReason: 'relay_not_forwarding',
        coordinatorPollAgeMs: 67 * MINUTE,
        relayContactAgeMs: 15_000,
        contactAgeMs: 15_000,
        connectionFlap: { stormActive: true, replacesInWindow: 11 },
      });
      expect(report.warnings).toContainEqual(expect.stringContaining(
        'polling the worker relay but no poll has reached the coordinator for 4020s (connection flap storm: 11 socket replaces)',
      ));
      expect(report.warnings).toContainEqual(expect.stringContaining('browser.recover_extension'));
    });

    it('gives a node with no coordinator poll yet one freshness window from registration', async () => {
      const now = 100 * MINUTE;
      const justRegistered = await healthService(relayNode(now - 5_000, now - 10_000), undefined, now).diagnose();
      expect(justRegistered.remoteExtensions.nodes[0]).toMatchObject({ channelState: 'fresh', commandsDeliverable: true });

      const longRegistered = await healthService(relayNode(now - 5_000, now - 5 * MINUTE), undefined, now).diagnose();
      expect(longRegistered.remoteExtensions.nodes[0]).toMatchObject({
        channelState: 'relay_not_forwarding',
        commandsDeliverable: false,
      });
    });

    it('stays silent (not relay_not_forwarding) when neither clock is fresh', async () => {
      const now = 100 * MINUTE;
      const report = await healthService(relayNode(now - 5 * MINUTE), now - 6 * MINUTE, now).diagnose();
      expect(report.remoteExtensions.nodes[0]).toMatchObject({ channelState: 'silent', silent: true });
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

  it('reports the RPC contract, per-session tool parity, and reliability events', async () => {
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
      workerNodeRegistry: { getAllNodes: () => [] },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      expectedToolSurface: () => ({
        names: ['browser.click', 'browser.evaluate'],
        surfaceHash: 'expected-hash',
      }),
      toolRevealStore: {
        listSurfaces: () => [
          {
            instanceId: 'instance-1',
            surface: {
              names: ['browser.click', 'browser.evaluate'],
              revealedNames: ['browser.evaluate'],
              protocolVersion: 1,
              surfaceHash: 'expected-hash',
              reportedAt: 5,
            },
          },
          {
            instanceId: 'instance-2',
            surface: {
              names: ['browser.click'],
              revealedNames: [],
              protocolVersion: 1,
              surfaceHash: 'stale-hash',
              reportedAt: 6,
            },
          },
        ],
      },
      reliabilityEvents: {
        recent: () => [{ at: 7, kind: 'node_disconnect', nodeId: 'node-1' }],
      },
      now: () => 10_000,
    });

    const report = await service.diagnose();

    expect(report.contract).toMatchObject({
      expectedToolCount: 2,
      expectedSurfaceHash: 'expected-hash',
    });
    expect(report.mcpSessions).toEqual([
      expect.objectContaining({
        instanceId: 'instance-1',
        schemaMatch: true,
        toolParity: { reportedCount: 2, expectedCount: 2, missing: [] },
      }),
      expect.objectContaining({
        instanceId: 'instance-2',
        schemaMatch: false,
        toolParity: {
          reportedCount: 1,
          expectedCount: 2,
          missing: ['browser.evaluate'],
        },
      }),
    ]);
    expect(report.recentReliabilityEvents).toEqual([
      { at: 7, kind: 'node_disconnect', nodeId: 'node-1' },
    ]);
    expect(report.warnings.some((warning) => warning.includes('instance-2'))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes('instance-1'))).toBe(false);
  });

  it('treats a live-but-incapable worker as not ready and names the remediation', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-1',
      name: 'windows-pc',
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
          extensionVersion: '0.2.19',
          lastExtensionContactAt: 9_500,
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
      now: () => 10_000,
    });

    const report = await service.diagnose();

    expect(report.status).toBe('partial');
    expect(report.remoteExtensions).toMatchObject({
      total: 1,
      ready: 0,
      silent: 0,
      nodes: [{
        nodeId: 'node-1',
        nodeName: 'windows-pc',
        enabled: true,
        running: true,
        silent: false,
        commandsDeliverable: false,
        commandsUndeliverableReason: workerAgentTooOldReason('windows-pc'),
      }],
    });
    expect(report.warnings).toContain(workerAgentTooOldReason('windows-pc'));
  });

  it('does not warn about worker skew for a node with no extension relay', async () => {
    const nodes: WorkerNodeInfo[] = [{
      id: 'node-2',
      name: 'build-box',
      address: '',
      status: 'connected',
      activeInstances: 0,
      capabilities: {
        platform: 'linux',
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: ['claude'],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
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
      now: () => 10_000,
    });

    const report = await service.diagnose();

    expect(report.status).toBe('ready');
    expect(report.remoteExtensions).toEqual({
      total: 0,
      ready: 0,
      silent: 0,
      nodes: [],
    });
    expect(report.warnings.some((warning) => warning.includes('worker agent'))).toBe(false);
  });

  it('reports renderer health per target and aggregates without tainting unrelated targets', async () => {
    const service = new BrowserHealthService({
      profileStore: { listProfiles: () => [] },
      targetRegistry: {
        listTargets: () => [{
          id: 'managed-wedged',
          profileId: 'managed-profile',
          driverTargetId: 'managed-wedged',
          mode: 'session',
          title: 'Managed',
          url: 'https://managed.example.test/',
          origin: 'https://managed.example.test',
          driver: 'cdp',
          status: 'available',
          lastSeenAt: 1,
        }],
      },
      listWedgedTargets: () => ['managed-wedged'],
      extensionTabStore: {
        listTabs: () => [{
          profileId: 'existing-profile',
          targetId: 'existing-healthy',
          tabId: 42,
          windowId: 7,
          title: 'Shared',
          url: 'https://portal.example.test/',
          origin: 'https://portal.example.test',
          text: '12:03 Greenwich Mean Time',
          allowedOrigins: [],
          attachedAt: 1,
          updatedAt: 1,
        }],
      },
      rawAutomationHealthService: {
        diagnose: async () => ({
          status: 'missing', checkedAt: 1, runtimeAvailable: false,
          nodeAvailable: true, inAppConfigured: false, inAppConnected: false,
          inAppToolCount: 0, configDetected: false, configSources: [],
          browserToolNames: [], warnings: [], suggestions: [],
          surface: 'legacy_raw_browser_automation',
        }),
      },
      workerNodeRegistry: { getAllNodes: () => [] },
      mcpBridgeAvailable: () => true,
      chromeRuntimeDetector: async () => ({ available: true, command: 'chrome' }),
      now: () => Date.parse('2026-01-15T12:03:00.000Z'),
    });

    const report = await service.diagnose();

    expect(report.renderer).toBe('wedged');
    expect(report.targetRenderers).toEqual([
      expect.objectContaining({
        targetId: 'managed-wedged', mode: 'managed', renderer: 'wedged',
        suggestedAction: 'browser.reload',
      }),
      expect.objectContaining({
        targetId: 'existing-healthy', mode: 'existing-tab', renderer: 'healthy',
      }),
    ]);
  });
});
