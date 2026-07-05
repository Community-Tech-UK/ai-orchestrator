import { describe, it, expect } from 'vitest';
import {
  buildNodeHealthEntries,
  browserAutomationState,
  browserAutomationLabel,
  extensionRelayState,
  extensionRelayLabel,
  withPatchedExtensionRelay,
  androidAutomationState,
  androidAutomationLabel,
  loginCommandPreview,
  type NodeHealthEntry,
} from './remote-nodes-browser-automation';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

function entry(over: Partial<NodeHealthEntry> = {}): NodeHealthEntry {
  return {
    id: 'n1',
    name: 'windows-pc',
    status: 'connected',
    supportsBrowser: false,
    browserAutomationReady: false,
    extensionRelayReady: false,
    androidAutomationReady: false,
    supportsGpu: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 0,
    workingDirectories: [],
    supportedClis: [],
    ...over,
  };
}

describe('browserAutomationState', () => {
  it('off when no Chrome runtime', () => {
    expect(browserAutomationState(entry())).toBe('off');
  });

  it('chrome-only when Chrome present but automation not enabled', () => {
    expect(browserAutomationState(entry({ supportsBrowser: true }))).toBe('chrome-only');
  });

  it('enabled (not ready) when configured but Chrome not yet running', () => {
    expect(
      browserAutomationState(
        entry({
          supportsBrowser: true,
          browserAutomationReady: true,
          browserAutomation: { enabled: true, headless: false, profileDir: '/p', running: false },
        }),
      ),
    ).toBe('enabled');
  });

  it('ready only when the managed Chrome is actually running', () => {
    expect(
      browserAutomationState(
        entry({
          supportsBrowser: true,
          browserAutomationReady: true,
          browserAutomation: { enabled: true, headless: false, profileDir: '/p', running: true },
        }),
      ),
    ).toBe('ready');
  });

  it('labels reflect the state', () => {
    expect(browserAutomationLabel(entry())).toMatch(/off/);
    expect(
      browserAutomationLabel(
        entry({
          supportsBrowser: true,
          browserAutomationReady: true,
          browserAutomation: { enabled: true, headless: false, profileDir: '/p', running: false },
        }),
      ),
    ).toMatch(/starts on first use/);
  });
});

describe('buildNodeHealthEntries', () => {
  it('does not infer a platform from fallback capabilities for disconnected roster entries', () => {
    const entries = buildNodeHealthEntries([
      {
        id: 'node-unknown',
        name: 'paired-worker',
        status: 'disconnected',
        address: '',
        connected: false,
        supportedClis: [],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        activeInstances: 0,
        maxConcurrentInstances: 0,
        workingDirectories: [],
        capabilities: {
          platform: 'linux',
          arch: '',
          cpuCores: 0,
          totalMemoryMB: 0,
          availableMemoryMB: 0,
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 0,
          workingDirectories: [],
          browsableRoots: [],
          discoveredProjects: [],
        },
      } satisfies RemoteNodeRosterEntry,
    ]);

    expect(entries[0].platform).toBeUndefined();
  });
});

describe('extensionRelayState', () => {
  it('is off when the relay has not been enabled', () => {
    expect(extensionRelayState(entry())).toBe('off');
    expect(extensionRelayLabel(entry())).toMatch(/off/);
  });

  it('is enabled when configured but not currently running', () => {
    const node = entry({
      extensionRelay: { enabled: true, running: false, socketPath: '/tmp/relay.sock' },
    });

    expect(extensionRelayState(node)).toBe('enabled');
    expect(extensionRelayLabel(node)).toMatch(/enabled/);
  });

  it('is ready when the worker reports the relay capability', () => {
    const node = entry({
      extensionRelayReady: true,
      extensionRelay: { enabled: true, running: true, socketPath: '/tmp/relay.sock' },
    });

    expect(extensionRelayState(node)).toBe('ready');
  });

  it('patches live node capabilities from an authoritative summary', () => {
    const nodes = [{
      id: 'n1',
      name: 'windows-pc',
      address: '',
      capabilities: {
        platform: 'win32' as const,
        arch: 'x64',
        cpuCores: 8,
        totalMemoryMB: 16_384,
        availableMemoryMB: 8_192,
        supportedClis: [],
        hasBrowserRuntime: true,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        maxConcurrentInstances: 4,
        workingDirectories: [],
        browsableRoots: [],
        discoveredProjects: [],
      },
      status: 'connected' as const,
      activeInstances: 0,
    }];

    const patched = withPatchedExtensionRelay(nodes, 'n1', {
      enabled: true,
      running: true,
      socketPath: '/tmp/relay.sock',
    });

    expect(patched[0].capabilities.hasExtensionRelay).toBe(true);
    expect(patched[0].capabilities.extensionRelay?.socketPath).toBe('/tmp/relay.sock');
  });
});

describe('loginCommandPreview', () => {
  it('is empty until the profile is known', () => {
    expect(loginCommandPreview(entry({ platform: 'win32' }), 'https://x')).toBe('');
  });

  it('builds the platform command once profile + platform are known', () => {
    const cmd = loginCommandPreview(
      entry({
        platform: 'win32',
        browserAutomation: { enabled: true, headless: false, profileDir: 'C:\\p', running: false },
      }),
      'https://www.facebook.com',
    );
    expect(cmd).toContain('Start-Process');
    expect(cmd).toContain('--user-data-dir=C:\\p');
  });

  it('returns empty on an unsafe URL rather than throwing', () => {
    const cmd = loginCommandPreview(
      entry({
        platform: 'linux',
        browserAutomation: { enabled: true, headless: false, profileDir: '/p', running: false },
      }),
      'javascript:alert(1)',
    );
    expect(cmd).toBe('');
  });
});

describe('androidAutomationState', () => {
  it('is off when no SDK is detected', () => {
    expect(androidAutomationState(entry())).toBe('off');
  });

  it('shows sdk-only when adb is present but automation is disabled', () => {
    expect(
      androidAutomationState(
        entry({
          androidAutomation: {
            enabled: false,
            sdkPath: 'C:\\Android\\Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: [],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        }),
      ),
    ).toBe('sdk-only');
  });

  it('shows enabled when mobile MCP is enabled but no device is currently online', () => {
    expect(
      androidAutomationState(
        entry({
          androidAutomationReady: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:\\Android\\Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: ['Pixel_8'],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: true,
          },
        }),
      ),
    ).toBe('enabled');
  });

  it('shows sdk-only when automation is enabled but no device or AVD is usable', () => {
    expect(
      androidAutomationState(
        entry({
          androidAutomationReady: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:\\Android\\Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: [],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        }),
      ),
    ).toBe('sdk-only');
  });

  it('shows ready when a device is online', () => {
    expect(
      androidAutomationState(
        entry({
          androidAutomationReady: true,
          androidAutomation: {
            enabled: true,
            sdkPath: 'C:\\Android\\Sdk',
            adbVersion: 'Android Debug Bridge version 1.0.41',
            avds: ['Pixel_8'],
            connectedDevices: [{ serial: 'emulator-5554', kind: 'emulator', state: 'device' }],
            emulatorRunning: true,
            hasMaestro: true,
          },
        }),
      ),
    ).toBe('ready');
  });

  it('labels reflect the state', () => {
    expect(androidAutomationLabel(entry())).toMatch(/off/);
    expect(
      androidAutomationLabel(
        entry({
          androidAutomationReady: true,
          androidAutomation: {
            enabled: true,
            sdkPath: '/sdk',
            adbVersion: 'adb',
            avds: ['Pixel_8'],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        }),
      ),
    ).toMatch(/starts emulator/);
    expect(
      androidAutomationLabel(
        entry({
          androidAutomationReady: true,
          androidAutomation: {
            enabled: true,
            sdkPath: '/sdk',
            adbVersion: 'adb',
            avds: [],
            connectedDevices: [],
            emulatorRunning: false,
            hasMaestro: false,
          },
        }),
      ),
    ).toMatch(/SDK detected/);
  });
});
