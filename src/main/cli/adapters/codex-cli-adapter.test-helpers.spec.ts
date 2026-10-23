import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupPreparedCodexHomes } from './codex-cli-adapter.test-helpers';
import { CodexHomeManager } from './codex/codex-home-manager';

const fixtures: string[] = [];
afterEach(() => { cleanupPreparedCodexHomes(); vi.unstubAllEnvs(); for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('Adapter test temporary-home cleanup', () => {
  it('cleans real prepared homes when a mocked process never exits and spies were restored', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'codex-home-cleanup-spec-'));
    fixtures.push(fixture);
    vi.stubEnv('HOME', fixture);
    const manager = new CodexHomeManager();
    const home = manager.prepareMcpFreeHome()!;
    expect(existsSync(home)).toBe(true);
    expect(JSON.parse(readFileSync(join(home, '.aio-codex-home-owner.json'), 'utf8'))).toMatchObject({ pid: process.pid });
    vi.restoreAllMocks(); // Existing adapter suites restore before shared teardown.
    cleanupPreparedCodexHomes();
    expect(existsSync(home)).toBe(false);
  });
});
