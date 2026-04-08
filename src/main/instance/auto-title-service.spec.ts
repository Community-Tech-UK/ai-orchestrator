import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateCliAdapter, mockResolveCliType, mockSendMessage } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockSendMessage: sendMessage,
    mockCreateCliAdapter: vi.fn(() => ({
      sendMessage,
    })),
    mockResolveCliType: vi.fn(),
  };
});

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: mockCreateCliAdapter,
  resolveCliType: mockResolveCliType,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({ defaultCli: 'codex' })),
  })),
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { AutoTitleService } from './auto-title-service';

describe('AutoTitleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveCliType.mockResolvedValue('codex');
    mockSendMessage.mockResolvedValue({ content: 'Codex task summary' });
    AutoTitleService._resetForTesting();
  });

  it('uses the resolved provider fast-tier model for Codex titles', async () => {
    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
      'codex',
    );

    expect(mockResolveCliType).toHaveBeenCalledWith('codex', 'codex');
    expect(mockCreateCliAdapter).toHaveBeenCalledWith('codex', expect.objectContaining({
      model: 'gpt-4o-mini',
    }));
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the...');
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Codex task summary');
  });
});
