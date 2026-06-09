import { describe, it, expect } from 'vitest';
import {
  browserAutomationState,
  browserAutomationLabel,
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
