import { beforeEach, describe, expect, it, vi } from 'vitest';

const detectAll = vi.fn();
const getUpdatePlan = vi.fn();

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
  });

  it('refreshes installed supported updater plans', async () => {
    const service = new CliUpdatePollService();

    const state = await service.refresh();

    expect(state.count).toBe(1);
    expect(state.entries[0]).toMatchObject({
      cli: 'claude',
      displayName: 'Claude Code',
      currentVersion: '1.0.0',
    });
    expect(getUpdatePlan).toHaveBeenCalledWith('claude');
    expect(getUpdatePlan).not.toHaveBeenCalledWith('codex');
  });

  it('emits change events when state changes', async () => {
    const service = new CliUpdatePollService();
    const listener = vi.fn();
    service.onChange(listener);

    await service.refresh();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
  });
});
