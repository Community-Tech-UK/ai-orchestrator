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
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.', 'instant');
    // Phase 2 AI title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'AI generated title', 'ai');
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
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.', 'instant');
    // Phase 2 should not have been attempted
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('does not accept requestedProvider parameter', async () => {
    // Verify the signature only takes 4 params
    const service = AutoTitleService.getInstance();
    expect(service.maybeGenerateTitle.length).toBeLessThanOrEqual(4);
  });

  it('folds the attachment filename into a generic instant title', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please fully implement this',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Fully implement loopfixex.md', 'instant');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('titles from the attachment when there is no message text', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      '',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'loopfixex.md', 'instant');
  });

  it('does not force the filename into an already-distinctive title', async () => {
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Refactor the AuthService session cache',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Refactor the AuthService session cache', 'instant');
  });

  it('discards an AI title that is actually a provider rate-limit notice', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: "You've hit your session limit · resets 6:30pm" });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Phase 1 instant title still applies...
    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      'instant',
    );
    // ...but the limit notice must never be stamped as the AI title.
    expect(applyTitle).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'ai');
  });

  it('keeps a legitimate AI title that merely mentions "limit"', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: 'Session-limit retry bug' });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Session-limit retry bug', 'ai');
  });

  it('passes attachment names to the AI title prompt', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please fully implement this',
      applyTitle,
      false,
      ['loopfixex.md'],
    );

    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('loopfixex.md'),
      }),
    );
  });
});
