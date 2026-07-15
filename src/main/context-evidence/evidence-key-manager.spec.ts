import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';
import { EvidenceKeyManager } from './evidence-key-manager';

const XOR_MASK = 0xa5;

interface DirectoryOperationNotice {
  kind: 'rename' | 'remove';
  directoryPath: string;
  sourceName: string;
  targetName?: string;
}

function createSafeStorage(available = true): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plaintext) => {
      const bytes = Buffer.from(plaintext, 'utf8');
      return Buffer.from(bytes.map((byte) => byte ^ XOR_MASK));
    },
    decryptString: (ciphertext) => {
      const bytes = Buffer.from(ciphertext.map((byte) => byte ^ XOR_MASK));
      return bytes.toString('utf8');
    },
  };
}

function createIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('content-free fixture failure'), { code });
}

describe('EvidenceKeyManager', () => {
  let userDataPath: string;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'aio-evidence-key-test-'));
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  it('creates and atomically persists a wrapped first-run data key', async () => {
    const manager = new EvidenceKeyManager({
      userDataPath,
      safeStorage: createSafeStorage(),
      now: () => 1_700_000_000_000,
    });

    const active = await manager.getActiveKey();
    const storagePath = join(userDataPath, 'conversation-evidence');
    const serialized = await readFile(join(storagePath, 'keyring.json'), 'utf8');
    const parsed = JSON.parse(serialized) as {
      activeKeyVersion: number;
      keys: { version: number; wrappedKey: string; activatedAt: number }[];
    };

    expect(active.version).toBe(1);
    expect(active.key).toHaveLength(32);
    expect(parsed).toMatchObject({ activeKeyVersion: 1 });
    expect(parsed.keys).toHaveLength(1);
    expect(parsed.keys[0]).toMatchObject({ version: 1, activatedAt: 1_700_000_000_000 });
    expect(parsed.keys[0]?.wrappedKey).not.toBe(Buffer.from(active.key).toString('base64'));
    expect(await readdir(storagePath)).toEqual(['keyring.json']);
  });

  it('unwraps the same key after restart', async () => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    const original = await first.getActiveKey();

    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });
    const restored = await restarted.getActiveKey();

    expect(restored.version).toBe(original.version);
    expect(restored.key).toEqual(original.key);
  });

  it('fails closed without creating storage when safeStorage is unavailable', async () => {
    const manager = new EvidenceKeyManager({
      userDataPath,
      safeStorage: createSafeStorage(false),
    });

    await expect(manager.getActiveKey()).rejects.toMatchObject({
      code: 'SAFE_STORAGE_UNAVAILABLE',
      message: 'Evidence encryption is unavailable',
    });
    await expect(readdir(userDataPath)).resolves.toEqual([]);
  });

  it('does not persist a first-run keyring with a nonfinite activation timestamp', async () => {
    const manager = new EvidenceKeyManager({
      userDataPath,
      safeStorage: createSafeStorage(),
      now: () => Number.POSITIVE_INFINITY,
    });

    await expect(manager.getActiveKey()).rejects.toMatchObject({ code: 'KEYRING_CORRUPT' });
    await expect(readdir(join(userDataPath, 'conversation-evidence'))).resolves.toEqual([]);
  });

  it('fails closed on malformed keyring JSON without replacing it', async () => {
    const storagePath = join(userDataPath, 'conversation-evidence');
    await mkdir(storagePath);
    await writeFile(join(storagePath, 'keyring.json'), '{invalid', 'utf8');
    const manager = new EvidenceKeyManager({ userDataPath, safeStorage: createSafeStorage() });

    await expect(manager.getActiveKey()).rejects.toMatchObject({
      code: 'KEYRING_CORRUPT',
      message: 'Evidence keyring is corrupt',
    });
    await expect(readFile(join(storagePath, 'keyring.json'), 'utf8')).resolves.toBe('{invalid');
  });

  it('fails closed when a wrapped key cannot be unwrapped', async () => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    await first.getActiveKey();
    const failingStorage: SafeStorageAccessor = {
      ...safeStorage,
      decryptString: () => {
        throw new Error('fixture decrypt detail');
      },
    };
    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage: failingStorage });

    await expect(restarted.getActiveKey()).rejects.toMatchObject({
      code: 'KEYRING_CORRUPT',
      message: 'Evidence keyring is corrupt',
    });
  });

  it('rejects a symlinked keyring without following it', async () => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    await first.getActiveKey();
    const storagePath = join(userDataPath, 'conversation-evidence');
    const keyringPath = join(storagePath, 'keyring.json');
    const outsidePath = join(userDataPath, 'outside-keyring.json');
    await rename(keyringPath, outsidePath);
    await symlink(outsidePath, keyringPath);
    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });

    await expect(restarted.getActiveKey()).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
      message: 'Evidence storage path is unsafe',
    });
  });

  it('rejects a keyring parent identity swap during open', async () => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    await first.getActiveKey();
    const storagePath = join(userDataPath, 'conversation-evidence');
    const keyringPath = join(storagePath, 'keyring.json');
    const backupPath = join(userDataPath, 'evidence-backup');
    const outsidePath = join(userDataPath, 'outside-evidence');
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, 'keyring.json'), await readFile(keyringPath));
    let swapped = false;
    const restarted = new EvidenceKeyManager({
      userDataPath,
      safeStorage,
      fileSystem: {
        open: async (target, flags, mode) => {
          if (!swapped && target.toString() === keyringPath) {
            swapped = true;
            await rename(storagePath, backupPath);
            await symlink(outsidePath, storagePath, 'dir');
          }
          return openFile(target, flags, mode);
        },
      },
    });

    await expect(restarted.getActiveKey()).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
      message: 'Evidence storage path is unsafe',
    });
  });

  it('binds keyring replacement to the verified directory when its pathname is swapped', async () => {
    const storagePath = join(userDataPath, 'conversation-evidence');
    const backupPath = join(userDataPath, 'keyring-rename-backup');
    const outsidePath = join(userDataPath, 'outside-keyring-rename');
    const outsideKeyringPath = join(outsidePath, 'keyring.json');
    const outsideSentinel = 'outside keyring must remain';
    await mkdir(outsidePath);
    await writeFile(outsideKeyringPath, outsideSentinel, 'utf8');
    let swapped = false;
    const beforeDirectoryOperation = async (operation: DirectoryOperationNotice) => {
      if (operation.kind !== 'rename' || swapped) return;
      swapped = true;
      await writeFile(join(outsidePath, operation.sourceName), 'outside temp must remain', 'utf8');
      await rename(storagePath, backupPath);
      await symlink(outsidePath, storagePath, 'dir');
    };
    const options = {
      userDataPath,
      safeStorage: createSafeStorage(),
      beforeDirectoryOperation,
    };
    const manager = new EvidenceKeyManager(options);

    await expect(manager.getActiveKey()).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideKeyringPath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('does not remove outside data when keyring replacement cleanup sees a pathname swap', async () => {
    const storagePath = join(userDataPath, 'conversation-evidence');
    const backupPath = join(userDataPath, 'keyring-cleanup-backup');
    const outsidePath = join(userDataPath, 'outside-keyring-cleanup');
    const outsideSentinel = 'outside keyring temp must remain';
    await mkdir(outsidePath);
    let swapped = false;
    let outsideTempPath = '';
    const beforeDirectoryOperation = async (operation: DirectoryOperationNotice) => {
      if (operation.kind === 'rename') throw createIoError('EIO');
      if (operation.kind !== 'remove' || swapped) return;
      swapped = true;
      outsideTempPath = join(outsidePath, operation.sourceName);
      await writeFile(outsideTempPath, outsideSentinel, 'utf8');
      await rename(storagePath, backupPath);
      await symlink(outsidePath, storagePath, 'dir');
    };
    const options = {
      userDataPath,
      safeStorage: createSafeStorage(),
      beforeDirectoryOperation,
    };
    const manager = new EvidenceKeyManager(options);

    await expect(manager.getActiveKey()).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideTempPath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it.each([
    ['zero active version', (keyring: Record<string, unknown>) => { keyring['activeKeyVersion'] = 0; }],
    ['version above uint32', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['version'] = 0x1_0000_0000;
      keyring['activeKeyVersion'] = 0x1_0000_0000;
    }],
    ['unsafe integer version', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['version'] = Number.MAX_SAFE_INTEGER + 1;
      keyring['activeKeyVersion'] = Number.MAX_SAFE_INTEGER + 1;
    }],
    ['empty wrapped key', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['wrappedKey'] = '';
    }],
    ['noncanonical wrapped key', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['wrappedKey'] = 'AAAA====';
    }],
    ['nonfinite activation timestamp', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['activatedAt'] = null;
    }],
    ['retirement before activation', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['retiredAt'] = (keys[0]!['activatedAt'] as number) - 1;
    }],
    ['retired active key', (keyring: Record<string, unknown>) => {
      const keys = keyring['keys'] as Record<string, unknown>[];
      keys[0]!['retiredAt'] = keys[0]!['activatedAt'];
    }],
  ])('rejects corrupt keyring state: %s', async (_name, mutate) => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    await first.getActiveKey();
    const keyringPath = join(userDataPath, 'conversation-evidence', 'keyring.json');
    const keyring = JSON.parse(await readFile(keyringPath, 'utf8')) as Record<string, unknown>;
    mutate(keyring);
    await writeFile(keyringPath, JSON.stringify(keyring), 'utf8');

    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });
    await expect(restarted.getActiveKey()).rejects.toMatchObject({ code: 'KEYRING_CORRUPT' });
  });

  it('rejects multiple unretired keys and out-of-order activation timestamps', async () => {
    let now = 1_700_000_000_000;
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage, now: () => now });
    await first.getActiveKey();
    now += 1_000;
    await first.rotateKey();
    const keyringPath = join(userDataPath, 'conversation-evidence', 'keyring.json');
    const keyring = JSON.parse(await readFile(keyringPath, 'utf8')) as {
      keys: { activatedAt: number; retiredAt?: number }[];
    };
    delete keyring.keys[0]!.retiredAt;
    keyring.keys[1]!.activatedAt = keyring.keys[0]!.activatedAt - 1;
    await writeFile(keyringPath, JSON.stringify(keyring), 'utf8');

    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });
    await expect(restarted.getActiveKey()).rejects.toMatchObject({ code: 'KEYRING_CORRUPT' });
  });

  it('rejects overlapping retirement and activation timestamps', async () => {
    let now = 1_700_000_000_000;
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage, now: () => now });
    await first.getActiveKey();
    now += 1_000;
    await first.rotateKey();
    const keyringPath = join(userDataPath, 'conversation-evidence', 'keyring.json');
    const keyring = JSON.parse(await readFile(keyringPath, 'utf8')) as {
      keys: { activatedAt: number; retiredAt?: number }[];
    };
    keyring.keys[0]!.retiredAt = keyring.keys[1]!.activatedAt + 1;
    await writeFile(keyringPath, JSON.stringify(keyring), 'utf8');

    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });
    await expect(restarted.getActiveKey()).rejects.toMatchObject({ code: 'KEYRING_CORRUPT' });
  });

  it.each([
    ['backward', 1_699_999_999_999],
    ['nonfinite', Number.POSITIVE_INFINITY],
  ])('rejects a %s rotation timestamp before replacing the keyring', async (_name, nextNow) => {
    let now = 1_700_000_000_000;
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage, now: () => now });
    await first.getActiveKey();
    const keyringPath = join(userDataPath, 'conversation-evidence', 'keyring.json');
    const before = await readFile(keyringPath, 'utf8');
    now = nextNow;

    await expect(first.rotateKey()).rejects.toMatchObject({ code: 'KEYRING_CORRUPT' });
    await expect(readFile(keyringPath, 'utf8')).resolves.toBe(before);
  });

  it('rejects rotation overflow before replacing the keyring', async () => {
    const safeStorage = createSafeStorage();
    const first = new EvidenceKeyManager({ userDataPath, safeStorage });
    await first.getActiveKey();
    const keyringPath = join(userDataPath, 'conversation-evidence', 'keyring.json');
    const keyring = JSON.parse(await readFile(keyringPath, 'utf8')) as {
      activeKeyVersion: number;
      keys: { version: number }[];
    };
    keyring.activeKeyVersion = 0xffff_ffff;
    keyring.keys[0]!.version = 0xffff_ffff;
    const before = `${JSON.stringify(keyring)}\n`;
    await writeFile(keyringPath, before, 'utf8');
    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });

    await expect(restarted.rotateKey()).rejects.toMatchObject({
      code: 'KEY_VERSION_OVERFLOW',
      message: 'Evidence key version cannot be rotated',
    });
    await expect(readFile(keyringPath, 'utf8')).resolves.toBe(before);
  });

  it('rotates to a new version while retaining older keys in memory and on restart', async () => {
    let now = 1_700_000_000_000;
    const safeStorage = createSafeStorage();
    const manager = new EvidenceKeyManager({ userDataPath, safeStorage, now: () => now });
    const first = await manager.getActiveKey();
    now += 1_000;

    const second = await manager.rotateKey();

    expect(second.version).toBe(2);
    expect(second.key).not.toEqual(first.key);
    expect(await manager.getKey(1)).toEqual(first.key);
    const restarted = new EvidenceKeyManager({ userDataPath, safeStorage });
    expect((await restarted.getActiveKey()).version).toBe(2);
    expect(await restarted.getKey(1)).toEqual(first.key);
    const keyring = JSON.parse(
      await readFile(join(userDataPath, 'conversation-evidence', 'keyring.json'), 'utf8'),
    ) as { keys: { retiredAt?: number }[] };
    expect(keyring.keys[0]?.retiredAt).toBe(now);
  });

  it('returns defensive copies of unwrapped key bytes', async () => {
    const manager = new EvidenceKeyManager({ userDataPath, safeStorage: createSafeStorage() });
    const first = await manager.getActiveKey();
    const originalByte = first.key[0];
    first.key[0] = originalByte ^ 0xff;

    expect((await manager.getActiveKey()).key[0]).toBe(originalByte);
  });
});
