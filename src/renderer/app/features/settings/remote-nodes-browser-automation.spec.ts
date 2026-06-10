import { describe, it, expect } from 'vitest';
import {
  browserAutomationState,
  browserAutomationLabel,
  androidAutomationState,
  androidAutomationLabel,
  loginCommandPreview,
  type NodeHealthEntry,
} from './remote-nodes-browser-automation';

function entry(over: Partial<NodeHealthEntry> = {}): NodeHealthEntry {
  return {
    id: 'n1',
    name: 'windows-pc',
    status: 'connected',
    supportsBrowser: false,
    browserAutomationReady: false,
    androidAutomationReady: false,
    supportsGpu: false,
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
