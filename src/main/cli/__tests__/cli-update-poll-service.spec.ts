import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectAll = vi.fn();
const getUpdatePlan = vi.fn();
const resolveLatestVersion = vi.fn();

vi.mock('../cli-detection', () => ({
  SUPPORTED_CLIS: ['claude', 'codex'],
  CLI_REGISTRY: {
    claude: { displayName: 'Claude Code' },
    codex: { displayName: 'OpenAI Codex' },
  },
  getCliDetectionService: () => ({
    detectAll,
  }),
}));

vi.mock('../cli-update-service', () => ({
  getCliUpdateService: () => ({
    getUpdatePlan,
  }),
}));

vi.mock('../cli-latest-version', () => ({
  getCliLatestVersionService: () => ({
    resolveLatestVersion,
  }),
}));

import { CliUpdatePollService } from '../cli-update-poll-service';

describe('CliUpdatePollService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectAll.mockResolvedValue({
      detected: [
        { name: 'claude', installed: true, version: '1.0.0' },
        { name: 'codex', installed: false },
      ],
    });
    getUpdatePlan.mockResolvedValue({
      cli: 'claude',
      displayName: 'Claude Code',
      supported: true,
      currentVersion: '1.0.0',
      displayCommand: 'npm install -g @anthropic-ai/claude-code@latest',
    });
    // Default: latest version unknown (registry unreachable / no package).
    resolveLatestVersion.mockResolvedValue(null);
  });

  it('lists installed supported updaters but does not flag updates when latest is unknown', async () => {
    const service = new CliUpdatePollService();

    const state = await service.refresh();

    // entries lists every installed CLI with a configured updater, but
    // count only ticks up when we've confirmed a newer version exists.
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0]).toMatchObject({
      cli: 'claude',
      displayName: 'Claude Code',
      currentVersion: '1.0.0',
      updateAvailable: false,
    });
    expect(state.entries[0]?.latestVersion).toBeUndefined();
    expect(state.count).toBe(0);
    expect(getUpdatePlan).toHaveBeenCalledWith('claude');
    expect(getUpdatePlan).not.toHaveBeenCalledWith('codex');
    expect(resolveLatestVersion).toHaveBeenCalledWith('claude');
  });

  it('flags updateAvailable when the registry reports a newer version', async () => {
    resolveLatestVersion.mockResolvedValue('2.0.0');
    const service = new CliUpdatePollService();

    const state = await service.refresh();

    expect(state.entries[0]).toMatchObject({
      cli: 'claude',
      currentVersion: '1.0.0',
      latestVersion: '2.0.0',
      updateAvailable: true,
    });
    expect(state.count).toBe(1);
  });

  it('does not flag an update when the installed version matches latest', async () => {
    resolveLatestVersion.mockResolvedValue('1.0.0');
    const service = new CliUpdatePollService();

    const state = await service.refresh();

    expect(state.entries[0]).toMatchObject({
      currentVersion: '1.0.0',
      latestVersion: '1.0.0',
      updateAvailable: false,
    });
    expect(state.count).toBe(0);
  });

  it('does not flag an update when the installed version is newer than latest', async () => {
    // e.g. a locally built / prerelease CLI ahead of the published latest.
    resolveLatestVersion.mockResolvedValue('0.9.0');
    const service = new CliUpdatePollService();

    const state = await service.refresh();

    expect(state.entries[0]?.updateAvailable).toBe(false);
    expect(state.count).toBe(0);
  });

  it('emits change events when state changes', async () => {
    const service = new CliUpdatePollService();
    const listener = vi.fn();
    service.onChange(listener);

    await service.refresh();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ count: 0 }));
  });
});
