import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateAdapter, mockResolveCliType, mockSendMessage, mockIsCliAvailable } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockSendMessage: sendMessage,
    mockCreateAdapter: vi.fn(() => ({
      sendMessage,
    })),
    mockResolveCliType: vi.fn(),
    mockIsCliAvailable: vi.fn(),
  };
});

vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: mockResolveCliType,
}));

vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: mockCreateAdapter,
  })),
}));

vi.mock('../cli/cli-detection', () => ({
  isCliAvailable: mockIsCliAvailable,
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
    mockSendMessage.mockResolvedValue({ content: 'AI generated title' });
    AutoTitleService._resetForTesting();
  });

  it('prefers claude for title generation even when codex is available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude' || type === 'codex',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Should resolve to claude (first in preference order), not codex
    expect(mockResolveCliType).toHaveBeenCalledWith('claude');
    expect(mockCreateAdapter).toHaveBeenCalledWith({
      cliType: 'claude',
      options: expect.objectContaining({
        model: expect.any(String),
      }),
    });
    // Phase 1 instant title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.');
    // Phase 2 AI title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'AI generated title');
  });

  it('falls back to gemini when claude is not available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'gemini' || type === 'codex',
    }));
    mockResolveCliType.mockResolvedValue('gemini');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(mockResolveCliType).toHaveBeenCalledWith('gemini');
    expect(mockCreateAdapter).toHaveBeenCalledWith({
      cliType: 'gemini',
      options: expect.objectContaining({
        model: expect.any(String),
      }),
    });
  });

  it('keeps instant title when no CLI is available', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Phase 1 instant title should still apply
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.');
    // Phase 2 should not have been attempted
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('does not accept requestedProvider parameter', async () => {
    // Verify the signature only takes 4 params
    const service = AutoTitleService.getInstance();
    expect(service.maybeGenerateTitle.length).toBeLessThanOrEqual(4);
  });
});
