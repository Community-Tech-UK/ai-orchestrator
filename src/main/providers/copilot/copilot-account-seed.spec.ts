import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { seedCopilotProfileIdentity } from './copilot-account-seed';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'copilot-seed-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The shared config as the real CLI writes it: JSONC, scheme-bearing hosts. */
function sharedConfig(dir: string): string {
  const p = join(dir, 'shared-config.json');
  writeFileSync(
    p,
    `// managed by copilot\n${JSON.stringify({
      lastLoggedInUser: { host: 'https://github.com', login: 'LAWRENCJ_PE1' },
      loggedInUsers: [
        { host: 'https://github.com', login: 'shutupandshave' },
        { host: 'https://github.com', login: 'LAWRENCJ_PE1' },
      ],
    })}`,
  );
  return p;
}

describe('seeding a profile with an identity the machine already holds', () => {
  it('writes a config naming the login, so no second sign-in is needed', async () => {
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);

    const seeded = await seedCopilotProfileIdentity('lawrencj-pe1', 'LAWRENCJ_PE1', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });

    expect(seeded).toBe(true);
    const written = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(written.lastLoggedInUser).toEqual({ host: 'https://github.com', login: 'LAWRENCJ_PE1' });
    expect(written.loggedInUsers).toHaveLength(1);
  });

  it('keeps the CLI\'s scheme-bearing host, because the keychain is keyed on it', async () => {
    // Verified on the real machine: the keychain account is
    // `copilot-cli` / `https://github.com:LAWRENCJ_PE1`. Writing our normalised
    // bare `github.com` would point the profile at an entry that does not exist.
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);
    await seedCopilotProfileIdentity('p', 'LAWRENCJ_PE1', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });
    const written = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    expect(written.lastLoggedInUser.host).toBe('https://github.com');
  });

  it('never overwrites a profile that already has state', async () => {
    // Clobbering a signed-in profile's config would log the user out of it.
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);
    writeFileSync(join(home, 'config.json'), '{"lastLoggedInUser":{"login":"someone-else"}}');

    const seeded = await seedCopilotProfileIdentity('p', 'LAWRENCJ_PE1', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });

    expect(seeded).toBe(false);
    expect(readFileSync(join(home, 'config.json'), 'utf8')).toContain('someone-else');
  });

  it('does nothing for a login this machine is not signed in to', async () => {
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);
    const seeded = await seedCopilotProfileIdentity('p', 'not-signed-in', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });
    expect(seeded).toBe(false);
  });

  it('writes the config 0600 and never a token', async () => {
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);
    await seedCopilotProfileIdentity('p', 'LAWRENCJ_PE1', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });
    const configPath = join(home, 'config.json');
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    const raw = readFileSync(configPath, 'utf8');
    // The token stays in the keychain. This file names an identity, nothing more.
    expect(raw).not.toMatch(/token|copilotTokens|ghu_|gho_/i);
  });

  it('leaves no temp file behind', async () => {
    const dir = scratch();
    const home = join(dir, 'home');
    mkdirSync(home);
    await seedCopilotProfileIdentity('p', 'LAWRENCJ_PE1', {
      configPath: sharedConfig(dir),
      resolveHome: () => home,
    });
    expect(() => statSync(join(home, 'config.json.tmp'))).toThrow();
  });
});
