import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCodexAuthMode, _resetCodexAuthModeCacheForTesting } from './codex-auth-mode';

describe('readCodexAuthMode', () => {
  let dir: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'codex-auth-test-'));
    prevHome = process.env['CODEX_HOME'];
    process.env['CODEX_HOME'] = dir;
    _resetCodexAuthModeCacheForTesting();
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = prevHome;
    }
    rmSync(dir, { recursive: true, force: true });
    _resetCodexAuthModeCacheForTesting();
  });

  function writeAuth(obj: Record<string, unknown>): void {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify(obj), 'utf-8');
  }

  it('detects ChatGPT-account auth from auth_mode', () => {
    writeAuth({ auth_mode: 'chatgpt', OPENAI_API_KEY: null });
    expect(readCodexAuthMode(1_000)).toBe('chatgpt');
  });

  it('detects api-key auth from auth_mode', () => {
    writeAuth({ auth_mode: 'apikey' });
    expect(readCodexAuthMode(1_000)).toBe('api-key');
  });

  it('falls back to OPENAI_API_KEY presence when auth_mode is absent', () => {
    writeAuth({ OPENAI_API_KEY: 'sk-test' });
    expect(readCodexAuthMode(1_000)).toBe('api-key');
  });

  it('returns unknown when auth.json is missing', () => {
    // No auth.json written in the temp CODEX_HOME.
    expect(readCodexAuthMode(1_000)).toBe('unknown');
  });

  it('caches the reading within the TTL window (stale within 60s)', () => {
    writeAuth({ auth_mode: 'chatgpt' });
    expect(readCodexAuthMode(1_000)).toBe('chatgpt');
    // File changes, but a read within the TTL still returns the cached value.
    writeAuth({ auth_mode: 'apikey' });
    expect(readCodexAuthMode(5_000)).toBe('chatgpt');
  });

  it('re-reads after the TTL window expires', () => {
    writeAuth({ auth_mode: 'chatgpt' });
    expect(readCodexAuthMode(1_000)).toBe('chatgpt');
    writeAuth({ auth_mode: 'apikey' });
    expect(readCodexAuthMode(1_000 + 61_000)).toBe('api-key');
  });
});
