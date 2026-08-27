import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { discoverCopilotAccounts } from './copilot-account-discovery';

/**
 * Grounded in the real shape observed on 2026-08-25: the shared `~/.copilot`
 * config listed BOTH of the user's accounts with scheme-prefixed hosts, while
 * Harness's own home knew only one. Making the user retype what Copilot already
 * knew was pointless friction, and invited a typo in exactly the fields
 * identity verification then rejects.
 */
let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copilot-discovery-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeShared(contents: string): string {
  const dir = join(root, 'shared');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.json');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('discoverCopilotAccounts', () => {
  it('finds every signed-in account and normalizes the scheme-prefixed host', async () => {
    const configPath = writeShared(
      JSON.stringify({
        lastLoggedInUser: { host: 'https://github.com', login: 'LAWRENCJ_PE1' },
        loggedInUsers: [
          { host: 'https://github.com', login: 'shutupandshave' },
          { host: 'https://github.com', login: 'LAWRENCJ_PE1' },
        ],
      }),
    );
    const found = await discoverCopilotAccounts({ configPath });
    expect(found.map((a) => a.login)).toEqual(['shutupandshave', 'LAWRENCJ_PE1']);
    expect(found.every((a) => a.host === 'github.com')).toBe(true);
  });

  it('marks accounts that already have a Harness profile', async () => {
    const configPath = writeShared(
      JSON.stringify({
        loggedInUsers: [
          { host: 'https://github.com', login: 'shutupandshave' },
          { host: 'https://github.com', login: 'LAWRENCJ_PE1' },
        ],
      }),
    );
    const found = await discoverCopilotAccounts({
      configPath,
      // The stored profile still carries a scheme (pre-fix record) — matching
      // must survive that.
      existing: [{ login: 'shutupandshave', host: 'https://github.com' }],
    });
    expect(found.find((a) => a.login === 'shutupandshave')?.alreadyAdded).toBe(true);
    expect(found.find((a) => a.login === 'LAWRENCJ_PE1')?.alreadyAdded).toBe(false);
  });

  it('matches an existing profile case-insensitively', async () => {
    const configPath = writeShared(
      JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'OctoCat' }] }),
    );
    const found = await discoverCopilotAccounts({
      configPath,
      existing: [{ login: 'octocat', host: 'github.com' }],
    });
    expect(found[0].alreadyAdded).toBe(true);
  });

  it('deduplicates lastLoggedInUser against loggedInUsers', async () => {
    const configPath = writeShared(
      JSON.stringify({
        lastLoggedInUser: { host: 'https://github.com', login: 'octocat' },
        loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }],
      }),
    );
    expect(await discoverCopilotAccounts({ configPath })).toHaveLength(1);
  });

  it('never returns token material from the shared config', async () => {
    const secretShaped = 'gho_NOT_A_REAL_TOKEN_placeholder';
    const configPath = writeShared(
      JSON.stringify({
        loggedInUsers: [{ host: 'https://github.com', login: 'octocat' }],
        copilotTokens: { 'github.com:octocat': secretShaped },
      }),
    );
    const found = await discoverCopilotAccounts({ configPath });
    expect(JSON.stringify(found)).not.toContain(secretShaped);
    expect(JSON.stringify(found)).not.toContain('copilotTokens');
  });

  it('returns nothing for an absent or malformed shared config', async () => {
    expect(await discoverCopilotAccounts({ configPath: join(root, 'nope.json') })).toEqual([]);
    expect(await discoverCopilotAccounts({ configPath: writeShared('{ not json') })).toEqual([]);
  });

  it('skips entries with no login', async () => {
    const configPath = writeShared(
      JSON.stringify({ loggedInUsers: [{ host: 'https://github.com' }, { login: '  ' }] }),
    );
    expect(await discoverCopilotAccounts({ configPath })).toEqual([]);
  });
});
