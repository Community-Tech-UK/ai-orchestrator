import { describe, expect, it } from 'vitest';
import {
  CredentialVault,
  CredentialVaultError,
  generateStrongPassword,
  secretVerificationDigest,
  verifyFilledSecret,
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
  private readonly fieldsById = new Map<string, Array<{ name: string; value: string }>>();
  private folderExists = true;
  private nextId = 1;

  constructor(opts: { folderExists?: boolean } = {}) {
    this.folderExists = opts.folderExists ?? true;
  }

  /** Directly seed an item (used to plant an out-of-folder / personal item). */
  seedItem(id: string, folderId: string | null, username: string, password: string): void {
    this.items.set(id, { folderId, username, password });
  }

  /** Seed named Bitwarden custom fields on an item (generic-secret tests). */
  seedFields(id: string, fields: Array<{ name: string; value: string }>): void {
    this.fieldsById.set(id, fields);
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
          fields: (this.fieldsById.get(args[2] as string) ?? []).map((field) => ({
            name: field.name,
            value: field.value,
            type: 0,
          })),
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

describe('CredentialVault.getGenericSecretForFill (bank / generic secrets)', () => {
  function seedBoundItemWithFields(
    bw: FakeBw,
    bindings: MemoryBindings,
    fields: Array<{ name: string; value: string }>,
  ): string {
    const ref = 'supplier-1';
    bw.seedItem(ref, AGENT_FOLDER_ID, 'supplier', 'unused-pw');
    bw.seedFields(ref, fields);
    bindings.put({
      vaultItemRef: ref,
      origin: 'https://portal.example.gov.uk',
      username: 'supplier',
      createdAt: 1,
    });
    return ref;
  }

  it('resolves a bank account number from a named custom field, case/format-insensitively', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);
    const ref = seedBoundItemWithFields(bw, bindings, [
      { name: 'Account Number', value: '12345678' },
      { name: 'Sort Code', value: '01-02-03' },
      { name: 'IBAN', value: 'GB33BUKB20201555555555' },
    ]);

    expect(
      await vault.getGenericSecretForFill({ vaultItemRef: ref, origin: 'https://portal.example.gov.uk', kind: 'bank_account_number' }),
    ).toBe('12345678');
    expect(
      await vault.getGenericSecretForFill({ vaultItemRef: ref, origin: 'https://portal.example.gov.uk', kind: 'bank_sort_code' }),
    ).toBe('01-02-03');
    expect(
      await vault.getGenericSecretForFill({ vaultItemRef: ref, origin: 'https://portal.example.gov.uk', kind: 'iban' }),
    ).toBe('GB33BUKB20201555555555');
  });

  it('resolves an arbitrary named field by its exact (normalized) name', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);
    const ref = seedBoundItemWithFields(bw, bindings, [{ name: 'Charity Number', value: 'CH-9981' }]);

    expect(
      await vault.getGenericSecretForFill({
        vaultItemRef: ref,
        origin: 'https://portal.example.gov.uk',
        kind: 'arbitrary_named_vault_field',
        fieldName: 'charity number',
      }),
    ).toBe('CH-9981');
  });

  it('enforces the SAME folder-jail and origin-binding guarantees as login secrets', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);
    const ref = seedBoundItemWithFields(bw, bindings, [{ name: 'IBAN', value: 'GB00SECRET' }]);

    // Wrong origin → anti-phishing refusal.
    await expect(
      vault.getGenericSecretForFill({ vaultItemRef: ref, origin: 'https://evil.example', kind: 'iban' }),
    ).rejects.toMatchObject({ code: 'origin_mismatch' });

    // Out-of-folder personal item → jail refusal.
    bw.seedItem('personal-iban', 'folder-personal', 'james', 'x');
    bw.seedFields('personal-iban', [{ name: 'IBAN', value: 'GB00PERSONAL' }]);
    bindings.put({ vaultItemRef: 'personal-iban', origin: 'https://portal.example.gov.uk', username: 'james', createdAt: 1 });
    await expect(
      vault.getGenericSecretForFill({ vaultItemRef: 'personal-iban', origin: 'https://portal.example.gov.uk', kind: 'iban' }),
    ).rejects.toMatchObject({ code: 'item_outside_agent_folder' });
  });

  it('throws custom_field_not_found (never a value) when the field is absent', async () => {
    const bw = new FakeBw();
    const { vault, bindings } = makeVault(bw);
    const ref = seedBoundItemWithFields(bw, bindings, [{ name: 'Account Number', value: '12345678' }]);

    const error = await vault
      .getGenericSecretForFill({ vaultItemRef: ref, origin: 'https://portal.example.gov.uk', kind: 'policy_number' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CredentialVaultError);
    expect((error as CredentialVaultError).code).toBe('custom_field_not_found');
    expect((error as Error).message).not.toContain('12345678');
  });
});

describe('worker-side secret verification (no value leaves the worker)', () => {
  it('verifies a correct read-back and rejects a wrong or empty one', () => {
    expect(verifyFilledSecret('12345678', '12345678')).toBe(true);
    expect(verifyFilledSecret('12345678', '1234')).toBe(false);
    expect(verifyFilledSecret('12345678', undefined)).toBe(false);
    expect(verifyFilledSecret('12345678', '')).toBe(false);
  });

  it('is a stable non-reversible digest (same input → same hash, different input → different)', () => {
    expect(secretVerificationDigest('abc')).toBe(secretVerificationDigest('abc'));
    expect(secretVerificationDigest('abc')).not.toBe(secretVerificationDigest('abd'));
    // The digest does not contain the plaintext.
    expect(secretVerificationDigest('super-secret')).not.toContain('super-secret');
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
