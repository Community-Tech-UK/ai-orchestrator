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

  it('prefers gemini for title generation even when copilot, claude, and codex are available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: ['gemini', 'copilot', 'claude', 'codex'].includes(type),
    }));
    mockResolveCliType.mockResolvedValue('gemini');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Should resolve to gemini (first in preference order), not a later provider.
    expect(mockIsCliAvailable).toHaveBeenCalledWith('gemini');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('copilot');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('claude');
    expect(mockIsCliAvailable).not.toHaveBeenCalledWith('codex');
    expect(mockResolveCliType).toHaveBeenCalledWith('gemini');
    expect(mockCreateAdapter).toHaveBeenCalledWith({
      cliType: 'gemini',
      options: expect.objectContaining({
        model: expect.any(String),
      }),
    });
    // Phase 1 instant title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the fix.', 'instant');
    // Phase 2 AI title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'AI generated title', 'ai');
  });

  it('falls back to copilot when gemini is not available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'copilot' || type === 'claude' || type === 'codex',
    }));
    mockResolveCliType.mockResolvedValue('copilot');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(mockIsCliAvailable).toHaveBeenNthCalledWith(1, 'gemini');
    expect(mockIsCliAvailable).toHaveBeenNthCalledWith(2, 'copilot');
    expect(mockResolveCliType).toHaveBeenCalledWith('copilot');
    expect(mockCreateAdapter).toHaveBeenCalledWith({
      cliType: 'copilot',
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

  it('folds the attachment filename into a generic instant title, subject-first', async () => {
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

    // Leads with the distinctive file subject, not the generic verb, so the
    // recognizable part survives rail truncation.
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Loopfixex implementation', 'instant');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('leads with the attachment subject for a plain "implement this" + long filename (screenshot case)', async () => {
    // No CLI: only the instant (Phase 1) title is exercised. Reproduces the
    // header that previously showed only "Implement…" because the verb led and
    // the distinctive filename was truncated away.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please implement this',
      applyTitle,
      false,
      ['2026-06-02-chrome-devtools-managed-profile-attach.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'Chrome devtools managed profile attach implementation',
      'instant',
    );
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('uses the attached plan subject instead of a trailing quality instruction', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Please implement this, be thorough',
      applyTitle,
      false,
      ['2026-05-28-first-class-remote-orchestration-plan.md'],
    );

    expect(applyTitle).toHaveBeenCalledWith(
      'instance-1',
      'First class remote orchestration implementation',
      'instant',
    );
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

  it('titles a loop-with-attachments kickoff from its files, not the injected header', async () => {
    // No CLI: only the instant (Phase 1) title is exercised.
    mockIsCliAvailable.mockResolvedValue({ installed: false });

    const applyTitle = vi.fn();

    const prompt = [
      'Attached files (relative to workspace; use your file-read tools):',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-05-30-mobile-control-app-plan.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-chrome-devtools-managed-profile-attach.md',
      '- .aio-loop-attachments/loop-1780437789286-a99d95f2/2026-06-02-outstanding-work-master-backlog.md',
      '',
      'Please work these files and implement them. Be thorough.',
    ].join('\n');

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      prompt,
      applyTitle,
      false,
    );

    // Before the fix this stamped "Attached files (relative to workspace; use…".
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Mobile control app implementation', 'instant');
    expect(mockCreateAdapter).not.toHaveBeenCalled();
  });

  it('strips the attachment preamble before sending the AI title prompt', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const prompt = [
      'Attached files (relative to workspace; use your file-read tools):',
      '- .aio-loop-attachments/loop-x/2026-05-30-mobile-control-app-plan.md',
      '',
      'Please work these files and implement them. Be thorough.',
    ].join('\n');

    await AutoTitleService.getInstance().generateTitle(prompt);

    const sent = mockSendMessage.mock.calls[0][0].content as string;
    // The injected boilerplate header must not reach the model...
    expect(sent).not.toContain('relative to workspace');
    // ...but the real file name should, as the attachment subject.
    expect(sent).toContain('2026-05-30-mobile-control-app-plan.md');
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

  it('repairs a low-signal AI title using the attached plan subject', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude',
    }));
    mockResolveCliType.mockResolvedValue('claude');
    mockSendMessage.mockResolvedValue({ content: 'Be thorough' });

    const title = await AutoTitleService.getInstance().generateTitle(
      'Please implement this, be thorough',
      ['2026-05-28-first-class-remote-orchestration-plan.md'],
    );

    expect(title).toBe('First class remote orchestration implementation');
  });
});
