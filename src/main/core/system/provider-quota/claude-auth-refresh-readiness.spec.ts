import { describe, expect, it, vi } from 'vitest';
import { createClaudeAuthRefreshReadiness, isClaudeRefreshPowerReady } from './claude-auth-refresh-readiness';

const AWAKE = 'Current System Capabilities are: CPU Graphics Audio Network \nCurrent Power State: 4';
const DARK_WAKE = 'Current System Capabilities are: CPU Network \nCurrent Power State: 4';

describe('Claude renewal readiness', () => {
  it.each([DARK_WAKE, '', 'Internal failure', 'Current System Capabilities are: CPU Graphics']) (
    'defers when graphical wake or network capability is missing: %s', async (output) => {
      const resolver = vi.fn().mockResolvedValue({});
      expect(await createClaudeAuthRefreshReadiness({
        platform: 'darwin', readPowerState: async () => output, resolver,
      })()).toBe(false);
      expect(resolver).not.toHaveBeenCalled();
    },
  );

  it('passes fully awake capabilities regardless of token order', () => {
    expect(isClaudeRefreshPowerReady(AWAKE)).toBe(true);
    expect(isClaudeRefreshPowerReady('Current System Capabilities are: Network CPU Graphics')).toBe(true);
    expect(isClaudeRefreshPowerReady('Current System Capabilities are: CPU NotGraphics Network')).toBe(false);
  });

  it('requires both actual Claude hosts', async () => {
    const resolver = vi.fn().mockResolvedValue({});
    expect(await createClaudeAuthRefreshReadiness({
      platform: 'darwin', readPowerState: async () => AWAKE, resolver,
    })()).toBe(true);
    expect(resolver.mock.calls.map(([host]) => host).sort()).toEqual(['api.anthropic.com', 'platform.claude.com']);
  });

  it.each(['platform.claude.com', 'api.anthropic.com'])('defers when %s fails DNS', async (failedHost) => {
    expect(await createClaudeAuthRefreshReadiness({
      platform: 'darwin', readPowerState: async () => AWAKE,
      resolver: async (host) => {
        if (host === failedHost) throw new Error('ENOTFOUND');
        return {};
      },
    })()).toBe(false);
  });

  it('bounds a hung DNS resolver and defers', async () => {
    vi.useFakeTimers();
    try {
      const pending = createClaudeAuthRefreshReadiness({
        platform: 'darwin', readPowerState: async () => AWAKE,
        resolver: () => new Promise(() => {}), probeTimeoutMs: 100,
      })();
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers when power-state inspection fails', async () => {
    expect(await createClaudeAuthRefreshReadiness({
      platform: 'darwin', readPowerState: async () => { throw new Error('timeout'); },
      resolver: async () => ({}),
    })()).toBe(false);
  });

  it('defers when the host returns to maintenance wake during DNS', async () => {
    let reads = 0;
    expect(await createClaudeAuthRefreshReadiness({
      platform: 'darwin', readPowerState: async () => ++reads === 1 ? AWAKE : DARK_WAKE,
      resolver: async () => ({}),
    })()).toBe(false);
  });

  it('does not run macOS commands on other platforms', async () => {
    const readPowerState = vi.fn();
    expect(await createClaudeAuthRefreshReadiness({
      platform: 'win32', readPowerState, resolver: async () => ({}),
    })()).toBe(true);
    expect(readPowerState).not.toHaveBeenCalled();
  });

  it('defers when the production resolver is unavailable', async () => {
    expect(await createClaudeAuthRefreshReadiness({ platform: 'linux', resolver: null })()).toBe(false);
  });
});
