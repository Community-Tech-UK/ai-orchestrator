import { describe, expect, it } from 'vitest';
import { normalizeCopilotHost } from './copilot-account.types';

/**
 * The installed Copilot CLI writes `lastLoggedInUser.host` WITH a scheme
 * (confirmed live on 2026-08-25: "https://github.com"), while git remotes and
 * routing rules use a bare hostname. Every persist and compare point funnels
 * through this normalizer so the two spellings can never diverge again.
 */
describe('normalizeCopilotHost', () => {
  it('strips the scheme the CLI writes', () => {
    expect(normalizeCopilotHost('https://github.com')).toBe('github.com');
    expect(normalizeCopilotHost('http://ghe.example.com')).toBe('ghe.example.com');
  });

  it('leaves an already-bare hostname alone', () => {
    expect(normalizeCopilotHost('github.com')).toBe('github.com');
  });

  it('normalizes case, trailing slash, trailing dot, and whitespace', () => {
    expect(normalizeCopilotHost('  HTTPS://GitHub.Com/  ')).toBe('github.com');
    expect(normalizeCopilotHost('github.com.')).toBe('github.com');
  });

  it('returns empty for absent input', () => {
    expect(normalizeCopilotHost(null)).toBe('');
    expect(normalizeCopilotHost(undefined)).toBe('');
    expect(normalizeCopilotHost('')).toBe('');
  });

  it('does NOT strip a port or userinfo — those change which host is meant', () => {
    // Left intact so the exact-hostname schema rejects them loudly rather than
    // this helper silently inventing a different host.
    expect(normalizeCopilotHost('https://github.com:8443')).toBe('github.com:8443');
    expect(normalizeCopilotHost('https://user@github.com')).toBe('user@github.com');
  });
});
