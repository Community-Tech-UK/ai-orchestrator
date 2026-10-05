import { describe, expect, it } from 'vitest';
import { CredentialVault, type BwRunner, type VaultOriginBinding } from './browser-credential-vault';

function setup(options: { folderExists?: boolean; names?: string[]; locked?: boolean; stale?: boolean } = {}) {
  const commands: string[][] = [];
  const bindings = new Map<string, VaultOriginBinding>();
  const runner: BwRunner = {
    run: async (args) => {
      commands.push(args);
      const items = (options.names ?? ['Saved test login']).map((name, index) => ({
        id: `item-${index}`, name, folderId: 'personal-folder',
        login: { username: 'TEST_ONLY_USERNAME', password: 'TEST_ONLY_PASSWORD' },
      }));
      let body: unknown;
      if (args[0] === 'list' && args[1] === 'folders') {
        body = options.folderExists === false ? [] : [{ id: 'agent-folder', name: 'AIO-Agent' }];
      } else if (args[0] === 'list' && args[1] === 'items') {
        body = items;
      } else {
        body = items.find((item) => item.id === args[2]) ?? items[0];
      }
      return { stdout: JSON.stringify(body), stderr: '', code: 0 };
    },
  };
  const vault = new CredentialVault({
    runner, bindings: { get: (id) => bindings.get(id), put: (binding) => bindings.set(binding.vaultItemRef, binding) },
    getSession: () => options.locked ? undefined : 'TEST_ONLY_SESSION',
  });
  return { vault, commands, bindings };
}

describe('saved login consent preview', () => {
  it('returns only exact non-secret metadata without moving an item or creating a folder', async () => {
    const { vault, commands, bindings } = setup({ folderExists: false });
    bindings.set('item-0', { vaultItemRef: 'item-0', origin: 'https://test.example', username: 'TEST_ONLY_USERNAME', createdAt: 10 });
    const preview = await vault.inspectExistingCredential({ item: 'Saved test login', origin: 'https://test.example' });
    expect(preview).toEqual({
      vaultItemRef: 'item-0', title: 'Saved test login', folderName: 'AIO-Agent', requiresMoveIntoFolder: true,
      existingBinding: { origin: 'https://test.example', createdAt: 10 },
    });
    expect(JSON.stringify(preview)).not.toContain('TEST_ONLY_USERNAME');
    expect(JSON.stringify(preview)).not.toContain('TEST_ONLY_PASSWORD');
    expect(commands.every((args) => ['get', 'list'].includes(args[0]!))).toBe(true);
  });

  it('refuses names shared by several vault items', async () => {
    const { vault } = setup({ names: ['Saved test login', 'Saved test login'] });
    await expect(vault.inspectExistingCredential({ item: 'Saved test login', origin: 'https://test.example' }))
      .rejects.toMatchObject({ code: 'item_ambiguous' });
  });

  it('refuses partial title matches even when Bitwarden returns one item', async () => {
    const { vault } = setup();
    await expect(vault.inspectExistingCredential({ item: 'Saved', origin: 'https://test.example' }))
      .rejects.toMatchObject({ code: 'item_not_found' });
  });

  it('refuses a preview on another website', async () => {
    const { vault, bindings } = setup();
    bindings.set('item-0', { vaultItemRef: 'item-0', origin: 'https://original.example', username: 'TEST_ONLY_USERNAME', createdAt: 10 });
    await expect(vault.inspectExistingCredential({ item: 'item-0', origin: 'https://other.example' }))
      .rejects.toMatchObject({ code: 'origin_mismatch' });
  });

  it('refuses inspection while locked without contacting Bitwarden', async () => {
    const { vault, commands } = setup({ locked: true });
    await expect(vault.inspectExistingCredential({ item: 'item-0', origin: 'https://test.example' }))
      .rejects.toMatchObject({ code: 'vault_locked' });
    expect(commands).toEqual([]);
  });

  it('pins enrolment to the exact item approved by the human', async () => {
    const { vault, commands } = setup();
    await expect(vault.enrolExistingCredential({
      item: 'item-0', expectedVaultItemRef: 'different-item', origin: 'https://test.example', moveIntoFolder: true,
    })).rejects.toMatchObject({ code: 'item_changed' });
    expect(commands.every((args) => ['get', 'list'].includes(args[0]!))).toBe(true);
  });

  it('drops a secret read completing after an explicit lock, even if unlocked again', async () => {
    let generation = 0;
    let finish: (value: { stdout: string; stderr: string; code: number }) => void = () => undefined;
    const vault = new CredentialVault({
      runner: { run: () => new Promise((resolve) => { finish = resolve; }) },
      bindings: { get: () => undefined, put: () => undefined },
      getSession: () => 'TEST_ONLY_SESSION', getSessionGeneration: () => generation,
    });
    const pending = vault.inspectExistingCredential({ item: 'item-0', origin: 'https://test.example' });
    generation += 1;
    finish({ stdout: JSON.stringify({ id: 'item-0', folderId: 'agent-folder', login: { password: 'TEST_ONLY_PASSWORD' } }), stderr: '', code: 0 });
    await expect(pending).rejects.toMatchObject({ code: 'vault_locked' });
  });
});
