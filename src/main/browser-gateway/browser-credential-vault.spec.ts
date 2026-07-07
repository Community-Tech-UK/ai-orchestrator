import { describe, expect, it } from 'vitest';
import {
  CredentialVault,
  CredentialVaultError,
  generateStrongPassword,
  type BwCommandResult,
  type BwRunner,
  type VaultOriginBinding,
  type VaultOriginBindingStore,
} from './browser-credential-vault';

const AGENT_FOLDER_ID = 'folder-agent';

/**
 * A fake `bw` CLI. Records commands, serves a scripted folder list and an item
 * store, and lets a test place items in arbitrary folders to exercise the jail.
 */
class FakeBw implements BwRunner {
  readonly commands: string[][] = [];
  private readonly items = new Map<string, { folderId: string | null; username: string; password: string }>();
  private folderExists = true;
  private nextId = 1;

  constructor(opts: { folderExists?: boolean } = {}) {
    this.folderExists = opts.folderExists ?? true;
  }

  /** Directly seed an item (used to plant an out-of-folder / personal item). */
  seedItem(id: string, folderId: string | null, username: string, password: string): void {
    this.items.set(id, { folderId, username, password });
  }

  async run(args: string[]): Promise<BwCommandResult> {
    this.commands.push(args);
    const ok = (stdout: string): BwCommandResult => ({ stdout, stderr: '', code: 0 });

    if (args[0] === 'list' && args[1] === 'folders') {
      return ok(JSON.stringify(this.folderExists ? [{ id: AGENT_FOLDER_ID, name: 'AIO-Agent' }] : []));
    }
    if (args[0] === 'create' && args[1] === 'folder') {
      return ok(JSON.stringify({ id: AGENT_FOLDER_ID, name: 'AIO-Agent' }));
    }
    if (args[0] === 'create' && args[1] === 'item') {
      const decoded = JSON.parse(Buffer.from(args[2] as string, 'base64').toString('utf-8'));
      const id = `item-${this.nextId++}`;
      this.items.set(id, {
        folderId: decoded.folderId,
        username: decoded.login.username,
        password: decoded.login.password,
      });
      return ok(JSON.stringify({ id, folderId: decoded.folderId, login: decoded.login }));
    }
    if (args[0] === 'sync') {
      return ok('Syncing complete.');
    }
    if (args[0] === 'get' && args[1] === 'item') {
      const item = this.items.get(args[2] as string);
      if (!item) {
        return { stdout: '', stderr: 'Not found.', code: 1 };
      }
      return ok(
        JSON.stringify({
          id: args[2],
          folderId: item.folderId,
          login: { username: item.username, password: item.password },
        }),
      );
    }
    if (args[0] === 'get' && args[1] === 'totp') {
      return ok('123456');
    }
    return { stdout: '', stderr: `unhandled: ${args.join(' ')}`, code: 1 };
  }
}

class MemoryBindings implements VaultOriginBindingStore {
  private readonly map = new Map<string, VaultOriginBinding>();
  put(binding: VaultOriginBinding): void {
    this.map.set(binding.vaultItemRef, binding);
  }
  get(ref: string): VaultOriginBinding | undefined {
    return this.map.get(ref);
  }
}

function makeVault(bw: FakeBw, opts: { locked?: boolean } = {}) {
  const bindings = new MemoryBindings();
  const vault = new CredentialVault({
    runner: bw,
    bindings,
    getSession: () => (opts.locked ? undefined : 'session-token'),
    generatePassword: () => 'Test-Password-123!',
    now: () => 1_000,
  });
  return { vault, bindings };
}

describe('CredentialVault.createAgentCredential', () => {
  it('stores a login in the agent folder and returns a ref + username, never the password', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);

    const result = await vault.createAgentCredential({
      origin: 'https://portal.example.gov.uk',
      username: 'james@communitytech.co.uk',
    });

    expect(result.username).toBe('james@communitytech.co.uk');
    expect(result.vaultItemRef).toMatch(/^item-/);
    // No password field anywhere in the returned object.
    expect(JSON.stringify(result)).not.toContain('Test-Password-123!');
    // Origin binding was recorded and a sync was issued.
    expect(bindings.get(result.vaultItemRef)?.origin).toBe('https://portal.example.gov.uk');
    expect(bw.commands.some((c) => c[0] === 'sync')).toBe(true);
  });

  it('reuses the existing agent folder rather than recreating it', async () => {
    const bw = new FakeBw({ folderExists: true });
    const { vault } = makeVault(bw);
    await vault.createAgentCredential({ origin: 'https://a.example', username: 'u' });
    expect(bw.commands.some((c) => c[0] === 'create' && c[1] === 'folder')).toBe(false);
  });

  it('creates the agent folder when it does not yet exist', async () => {
    const bw = new FakeBw({ folderExists: false });
    const { vault } = makeVault(bw);
    await vault.createAgentCredential({ origin: 'https://a.example', username: 'u' });
    expect(bw.commands.some((c) => c[0] === 'create' && c[1] === 'folder')).toBe(true);
  });
});

describe('CredentialVault.getSecretForFill (security invariants)', () => {
  it('returns the password for a correctly-bound, in-folder item', async () => {
    const bw = new FakeBw();
    const { vault } = makeVault(bw);
    const { vaultItemRef } = await vault.createAgentCredential({
      origin: 'https://portal.example.gov.uk',
      username: 'u',
    });

    const secret = await vault.getSecretForFill({
      vaultItemRef,
      origin: 'https://portal.example.gov.uk',
      kind: 'password',
    });
    expect(secret).toBe('Test-Password-123!');
  });

  it('refuses an item that is not inside the agent folder (the jail)', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);
    // Plant a personal item in a different folder, and forge a matching binding.
    bw.seedItem('personal-1', 'folder-personal', 'james', 'PERSONAL-SECRET');
    bindings.put({
      vaultItemRef: 'personal-1',
      origin: 'https://accounts.google.com',
      username: 'james',
      createdAt: 1,
    });

    await expect(
      vault.getSecretForFill({
        vaultItemRef: 'personal-1',
        origin: 'https://accounts.google.com',
        kind: 'password',
      }),
    ).rejects.toMatchObject({ code: 'item_outside_agent_folder' });
  });

  it('refuses when the live origin does not match the item binding (anti-phishing)', async () => {
    const bw = new FakeBw();
    const { vault } = makeVault(bw);
    const { vaultItemRef } = await vault.createAgentCredential({
      origin: 'https://portal.example.gov.uk',
      username: 'u',
    });

    await expect(
      vault.getSecretForFill({
        vaultItemRef,
        origin: 'https://evil.example',
        kind: 'password',
      }),
    ).rejects.toMatchObject({ code: 'origin_mismatch' });
  });

  it('refuses when there is no origin binding at all', async () => {
    const bw = new FakeBw();
    const { vault } = makeVault(bw);
    bw.seedItem('orphan', AGENT_FOLDER_ID, 'u', 'x');

    await expect(
      vault.getSecretForFill({ vaultItemRef: 'orphan', origin: 'https://a.example', kind: 'password' }),
    ).rejects.toMatchObject({ code: 'origin_binding_missing' });
  });

  it('throws vault_locked when there is no session, without invoking bw', async () => {
    const bw = new FakeBw();
    const { vault } = makeVault(bw, { locked: true });
    await expect(
      vault.createAgentCredential({ origin: 'https://a.example', username: 'u' }),
    ).rejects.toMatchObject({ code: 'vault_locked' });
    expect(bw.commands).toHaveLength(0);
  });

  it('never leaks the secret into a bw command failure message', async () => {
    const failing: BwRunner = {
      run: async () => ({ stdout: '', stderr: 'network error', code: 1 }),
    };
    const vault = new CredentialVault({
      runner: failing,
      bindings: new MemoryBindings(),
      getSession: () => 'session',
      generatePassword: () => 'SUPER-SECRET-PW',
    });
    const error = await vault
      .createAgentCredential({ origin: 'https://a.example', username: 'u' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialVaultError);
    expect((error as Error).message).not.toContain('SUPER-SECRET-PW');
  });
});

describe('generateStrongPassword', () => {
  it('produces a long password with all character classes and no ambiguous chars', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateStrongPassword();
      expect(pw.length).toBe(20);
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*()\-_=+[\]]/);
      // Ambiguous chars excluded from the charsets.
      expect(pw).not.toMatch(/[O0Il1]/);
    }
  });

  it('does not produce the same password twice in a row', () => {
    expect(generateStrongPassword()).not.toBe(generateStrongPassword());
  });
});
