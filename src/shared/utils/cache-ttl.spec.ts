import { describe, expect, it } from 'vitest';
import { resolveCacheTtlMs } from './cache-ttl';

describe('cache lifetime', () => {
  it('gives Claude 60 minutes on a plan and 5 on an API key, and nothing when billing is unknown', () => {
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'plan')).toBe(60 * 60_000);
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'api')).toBe(5 * 60_000);
    expect(resolveCacheTtlMs({ provider: 'claude' }, 'unknown')).toBeUndefined();
  });

  it('reads Copilot lifetimes from its reported cache state for the session model only', () => {
    const cache = [{ modelId: 'gpt', ttlSeconds: 1800, expiresAt: 123 }, { modelId: 'claude-x', ttlSeconds: 300, expiresAt: 456 }];
    expect(resolveCacheTtlMs({ provider: 'copilot', currentModel: 'gpt' }, 'credits', cache)).toBe(1_800_000);
    expect(resolveCacheTtlMs({ provider: 'copilot', currentModel: 'claude-x' }, 'credits', cache)).toBe(300_000);
    expect(resolveCacheTtlMs({ provider: 'copilot', currentModel: 'other' }, 'credits', cache)).toBeUndefined();
    expect(resolveCacheTtlMs({ provider: 'copilot', currentModel: 'gpt' }, 'credits')).toBeUndefined();
  });

  it('has no lifetime for Codex or other providers', () => {
    expect(resolveCacheTtlMs({ provider: 'codex' }, 'plan')).toBeUndefined();
    expect(resolveCacheTtlMs({ provider: 'gemini' }, 'plan')).toBeUndefined();
  });
});
