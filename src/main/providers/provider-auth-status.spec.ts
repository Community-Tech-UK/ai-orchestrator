import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claude: vi.fn(),
  codex: vi.fn(),
  gemini: vi.fn(),
}));

vi.mock('./claude-cli-auth', () => ({ checkClaudeCliAuthentication: mocks.claude }));
vi.mock('./codex-cli-auth', () => ({ checkCodexCliAuthentication: mocks.codex }));
vi.mock('./gemini-cli-auth', () => ({ checkGeminiCliAuthentication: mocks.gemini }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { canProbeProviderAuth, probeProviderAuth } from './provider-auth-status';

describe('provider-auth-status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('knows which providers can be probed', () => {
    expect(canProbeProviderAuth('claude')).toBe(true);
    expect(canProbeProviderAuth('codex')).toBe(true);
    expect(canProbeProviderAuth('gemini')).toBe(true);
    expect(canProbeProviderAuth('copilot')).toBe(false);
    expect(canProbeProviderAuth('cursor')).toBe(false);
    expect(canProbeProviderAuth('antigravity')).toBe(false);
  });

  it('maps an authenticated check to authenticated', async () => {
    mocks.claude.mockResolvedValue({ authenticated: true, message: 'ok' });

    await expect(probeProviderAuth('claude')).resolves.toBe('authenticated');
  });

  it('maps a failed check to unauthenticated', async () => {
    mocks.codex.mockResolvedValue({ authenticated: false, message: 'not logged in' });

    await expect(probeProviderAuth('codex')).resolves.toBe('unauthenticated');
  });

  it('returns unknown — never unauthenticated — when the probe throws', async () => {
    // A probe that cannot run is not evidence of a sign-out; callers rely on
    // this distinction so a broken probe never falsely blocks a session.
    mocks.gemini.mockRejectedValue(new Error('spawn gemini ENOENT'));

    await expect(probeProviderAuth('gemini')).resolves.toBe('unknown');
  });

  it('returns unknown for providers with no auth command', async () => {
    await expect(probeProviderAuth('copilot')).resolves.toBe('unknown');
    expect(mocks.claude).not.toHaveBeenCalled();
  });
});
