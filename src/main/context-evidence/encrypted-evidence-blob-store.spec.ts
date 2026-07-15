import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';
import { EncryptedEvidenceBlobStore } from './encrypted-evidence-blob-store';
import { EvidenceKeyManager } from './evidence-key-manager';
import type { EvidenceStorageFileSystem } from './evidence-storage.types';

function createSafeStorage(): SafeStorageAccessor {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(plaintext, 'utf8'),
    decryptString: (ciphertext) => ciphertext.toString('utf8'),
  };
}

function createIoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error('content-free fixture failure'), { code });
}

function wrapHandleSync(
  handle: Awaited<ReturnType<typeof openFile>>,
  sync: () => Promise<void>,
): Awaited<ReturnType<typeof openFile>> {
  return new Proxy(handle, {
    get(target, property) {
      if (property === 'sync') return sync;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface DirectoryOperationNotice {
  kind: 'rename' | 'remove';
  directoryPath: string;
  sourceName: string;
  targetName?: string;
}

describe('EncryptedEvidenceBlobStore', () => {
  let userDataPath: string;
  let store: EncryptedEvidenceBlobStore;
  let keyManager: EvidenceKeyManager;

  beforeEach(async () => {
    userDataPath = await mkdtemp(join(tmpdir(), 'aio-evidence-blob-test-'));
    keyManager = new EvidenceKeyManager({
      userDataPath,
      safeStorage: createSafeStorage(),
    });
    store = new EncryptedEvidenceBlobStore({ userDataPath, keyManager });
  });

  afterEach(async () => {
    await rm(userDataPath, { recursive: true, force: true });
  });

  function withFileSystem(
    fileSystem: Partial<EvidenceStorageFileSystem>,
  ): EncryptedEvidenceBlobStore {
    return new EncryptedEvidenceBlobStore({ userDataPath, keyManager, fileSystem });
  }

  function beforeDirectoryOperation(
    hook: (operation: DirectoryOperationNotice) => Promise<void>,
    fileSystem?: Partial<EvidenceStorageFileSystem>,
  ): EncryptedEvidenceBlobStore {
    const options = { userDataPath, keyManager, fileSystem, beforeDirectoryOperation: hook };
    return new EncryptedEvidenceBlobStore(options);
  }

  it('round-trips Uint8Array bytes through an AIOEV1 AES-256-GCM envelope', async () => {
    const plaintext = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const result = await store.write('fixture-conversation', plaintext);

    expect(result.blobRef).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{32}\.aioev1$/);
    expect(result.keyedContentId).toMatch(/^[a-f0-9]{64}$/);
    expect(result.byteCount).toBe(plaintext.byteLength);
    expect(await store.read(result.blobRef, result.keyedContentId)).toEqual(plaintext);
    const envelope = await readFile(
      join(userDataPath, 'conversation-evidence', result.blobRef),
    );
    expect(envelope.subarray(0, 6).toString('ascii')).toBe('AIOEV1');
    expect(envelope.byteLength).toBe(6 + 4 + 12 + plaintext.byteLength + 16);
    expect(envelope.readUInt32BE(6)).toBe(1);
    expect(envelope.subarray(10, 22)).toHaveLength(12);
    expect(envelope.subarray(22, -16)).toHaveLength(plaintext.byteLength);
    expect(envelope.subarray(22, -16)).not.toEqual(Buffer.from(plaintext));
    expect(envelope.subarray(-16)).toHaveLength(16);
  });

  it('stream-authenticates an exact bounded plaintext range without readFile', async () => {
    const plaintext = new TextEncoder().encode(`${'a'.repeat(80_000)}needle-tail`);
    const result = await store.write('fixture-conversation', plaintext);
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const streamingStore = withFileSystem({
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString() !== blobPath) return handle;
        return new Proxy(handle, {
          get(proxyTarget, property) {
            if (property === 'readFile') {
              return async () => { throw new Error('bounded reads must not call readFile'); };
            }
            const value = Reflect.get(proxyTarget, property, proxyTarget) as unknown;
            return typeof value === 'function' ? value.bind(proxyTarget) : value;
          },
        });
      },
    });
    const readRange = (streamingStore as unknown as {
      readRange?: (
        blobRef: string,
        expectedKeyedContentId: string,
        startByte: number,
        endByte: number,
      ) => Promise<Uint8Array>;
    }).readRange?.bind(streamingStore);

    expect(readRange).toBeTypeOf('function');
    if (!readRange) return;
    const bounded = await readRange(
      result.blobRef,
      result.keyedContentId,
      79_998,
      80_006,
    );
    expect(Buffer.from(bounded)).toEqual(Buffer.from(plaintext.slice(79_998, 80_006)));
  });

  it('finds a cross-chunk needle while retaining only a bounded result', async () => {
    const prefix = 'a'.repeat(65_534);
    const plaintext = new TextEncoder().encode(`${prefix}needle${'z'.repeat(100_000)}`);
    const result = await store.write('fixture-conversation', plaintext);
    const find = (store as unknown as {
      find?: (
        blobRef: string,
        expectedKeyedContentId: string,
        needle: Uint8Array,
        maxResultBytes: number,
      ) => Promise<{ startByte: number; bytes: Uint8Array } | null>;
    }).find?.bind(store);

    expect(find).toBeTypeOf('function');
    if (!find) return;
    const match = await find(
      result.blobRef,
      result.keyedContentId,
      new TextEncoder().encode('needle'),
      12,
    );
    expect(match?.startByte).toBe(prefix.length);
    expect(Buffer.from(match?.bytes ?? [])).toEqual(Buffer.from('needlezzzzzz'));
  });

  it('does not release a bounded range when final authentication fails', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('authenticated bounded fixture'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const envelope = await readFile(blobPath);
    envelope[envelope.length - 1] ^= 0xff;
    await writeFile(blobPath, envelope);
    const readRange = (store as unknown as {
      readRange?: (
        blobRef: string,
        expectedKeyedContentId: string,
        startByte: number,
        endByte: number,
      ) => Promise<Uint8Array>;
    }).readRange?.bind(store);

    expect(readRange).toBeTypeOf('function');
    if (!readRange) return;
    await expect(readRange(result.blobRef, result.keyedContentId, 0, 5))
      .rejects.toMatchObject({ code: 'BLOB_AUTH_FAILED' });
  });

  it('copies caller-owned Buffer bytes before the first await', async () => {
    const original = Buffer.from('original obvious fixture', 'utf8');
    const expected = Buffer.from(original);
    const active = await keyManager.getActiveKey();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(keyManager, 'getActiveKey').mockImplementationOnce(async () => {
      await gate;
      return active;
    });

    const pending = store.write('fixture-conversation', original);
    original.fill(0x78);
    release();
    const result = await pending;

    expect(await store.read(result.blobRef, result.keyedContentId)).toEqual(
      new Uint8Array(expected),
    );
    spy.mockRestore();
  });

  it('uses a fresh 12-byte nonce for identical plaintext', async () => {
    const plaintext = new TextEncoder().encode('obvious fixture payload');
    const first = await store.write('fixture-conversation', plaintext);
    const second = await store.write('fixture-conversation', plaintext);
    const firstEnvelope = await readFile(
      join(userDataPath, 'conversation-evidence', first.blobRef),
    );
    const secondEnvelope = await readFile(
      join(userDataPath, 'conversation-evidence', second.blobRef),
    );

    expect(first.keyedContentId).toBe(second.keyedContentId);
    expect(first.blobRef).not.toBe(second.blobRef);
    expect(firstEnvelope.subarray(10, 22)).not.toEqual(secondEnvelope.subarray(10, 22));
    expect(firstEnvelope).not.toEqual(secondEnvelope);
  });

  it('rejects authentication-tag tampering with a content-free error', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('tamper fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const envelope = await readFile(blobPath);
    envelope[envelope.length - 1] ^= 0xff;
    await writeFile(blobPath, envelope);

    await expect(store.read(result.blobRef, result.keyedContentId)).rejects.toMatchObject({
      code: 'BLOB_AUTH_FAILED',
      message: 'Evidence blob authentication failed',
    });
  });

  it('rejects an invalid envelope magic value', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('magic fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const envelope = await readFile(blobPath);
    envelope[0] ^= 0xff;
    await writeFile(blobPath, envelope);

    await expect(store.read(result.blobRef)).rejects.toMatchObject({
      code: 'BLOB_FORMAT_INVALID',
      message: 'Evidence blob format is invalid',
    });
  });

  it('authenticates the envelope key-version header', async () => {
    await keyManager.getActiveKey();
    await keyManager.rotateKey();
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('header fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const envelope = await readFile(blobPath);
    expect(envelope.readUInt32BE(6)).toBe(2);
    envelope.writeUInt32BE(1, 6);
    await writeFile(blobPath, envelope);

    await expect(store.read(result.blobRef)).rejects.toMatchObject({
      code: 'BLOB_AUTH_FAILED',
      message: 'Evidence blob authentication failed',
    });
  });

  it('derives opaque, key-separated directory, content, and citation identities', async () => {
    const bytes = new TextEncoder().encode('identity fixture payload');
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const otherDirectoryRef = await store.deriveConversationDirectoryRef('fixture-conversation-b');
    const contentId = await store.deriveContentId(bytes);
    const citationDigest = await store.deriveCitationDigest(bytes);

    expect(directoryRef).toMatch(/^[a-f0-9]{64}$/);
    expect(otherDirectoryRef).not.toBe(directoryRef);
    expect(directoryRef).not.toContain('fixture');
    expect(contentId).not.toBe(citationDigest);
    await expect(store.verifyCitationDigest(bytes, citationDigest)).resolves.toBe(true);
    await expect(
      store.verifyCitationDigest(new TextEncoder().encode('altered fixture payload'), citationDigest),
    ).resolves.toBe(false);
  });

  it('verifies keyed identities with the recorded key version after rotation', async () => {
    const bytes = new TextEncoder().encode('rotation identity fixture');
    const digest = await store.deriveCitationDigest(bytes);
    await keyManager.rotateKey();

    await expect(store.verifyCitationDigest(bytes, digest, 1)).resolves.toBe(true);
    await expect(store.verifyCitationDigest(bytes, digest)).resolves.toBe(false);
  });

  it.each([
    '../escape.aioev1',
    '/absolute/escape.aioev1',
    `${'a'.repeat(64)}/../../escape.aioev1`,
    `${'a'.repeat(64)}/not-opaque.aioev1`,
  ])('rejects non-opaque blob reference %s', async (blobRef) => {
    await expect(store.read(blobRef)).rejects.toMatchObject({
      code: 'BLOB_REF_INVALID',
      message: 'Evidence blob reference is invalid',
    });
  });

  it('rejects a symlinked blob without following it', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('symlink fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const outsidePath = join(userDataPath, 'outside-fixture.aioev1');
    await writeFile(outsidePath, 'obvious outside fixture', 'utf8');
    await rm(blobPath);
    await symlink(outsidePath, blobPath);

    await expect(store.read(result.blobRef)).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
      message: 'Evidence storage path is unsafe',
    });
  });

  it('removes one validated blob and makes subsequent reads unavailable', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('remove fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);

    await store.remove(result.blobRef);

    await expect(lstat(blobPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(store.read(result.blobRef)).rejects.toMatchObject({ code: 'BLOB_NOT_FOUND' });
  });

  it.each([
    '../escape.aioev1',
    '/absolute/escape.aioev1',
    `${'a'.repeat(64)}/../../escape.aioev1`,
  ])('refuses invalid removal reference %s', async (blobRef) => {
    await expect(store.remove(blobRef)).rejects.toMatchObject({
      code: 'BLOB_REF_INVALID',
      message: 'Evidence blob reference is invalid',
    });
  });

  it('refuses to remove a symlinked blob', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('remove symlink fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const outsidePath = join(userDataPath, 'outside-remove-fixture.aioev1');
    const outsideSentinel = 'outside remove target must remain';
    await writeFile(outsidePath, outsideSentinel, 'utf8');
    await rm(blobPath);
    await symlink(outsidePath, blobPath);

    await expect(store.remove(result.blobRef))
      .rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    await expect(readFile(outsidePath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('binds blob removal to the verified directory when its pathname is swapped', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('remove-swap fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const directoryPath = dirname(blobPath);
    const blobName = result.blobRef.split('/')[1]!;
    const backupPath = join(userDataPath, 'remove-backup');
    const outsidePath = join(userDataPath, 'outside-remove-directory');
    const outsideBlobPath = join(outsidePath, blobName);
    const outsideSentinel = 'outside blob must remain';
    await mkdir(outsidePath);
    await writeFile(outsideBlobPath, outsideSentinel, 'utf8');
    let swapped = false;
    const swappingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind !== 'remove' || swapped) return;
      swapped = true;
      await rename(directoryPath, backupPath);
      await symlink(outsidePath, directoryPath, 'dir');
    });

    await expect(swappingStore.remove(result.blobRef))
      .rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideBlobPath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('rejects a symlinked conversation directory on write', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const evidenceRoot = join(userDataPath, 'conversation-evidence');
    const outsideDirectory = join(userDataPath, 'outside-directory');
    await mkdir(outsideDirectory);
    await symlink(outsideDirectory, join(evidenceRoot, directoryRef));

    await expect(
      store.write('fixture-conversation', new TextEncoder().encode('write fixture payload')),
    ).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
      message: 'Evidence storage path is unsafe',
    });
    await expect(readdir(outsideDirectory)).resolves.toEqual([]);
  });

  it('rejects a parent identity swap while opening a staging file before writing bytes', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const evidenceRoot = join(userDataPath, 'conversation-evidence');
    const directoryPath = join(evidenceRoot, directoryRef);
    const backupPath = join(userDataPath, 'conversation-backup');
    const outsidePath = join(userDataPath, 'outside-write-directory');
    await mkdir(directoryPath);
    await mkdir(outsidePath);
    let swapped = false;
    const swappingStore = withFileSystem({
      open: async (target, flags, mode) => {
        if (!swapped && target.toString().includes('.staging-')) {
          swapped = true;
          await rename(directoryPath, backupPath);
          await symlink(outsidePath, directoryPath, 'dir');
        }
        return openFile(target, flags, mode);
      },
    });

    await expect(
      swappingStore.write(
        'fixture-conversation',
        new TextEncoder().encode('must not escape fixture payload'),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    const outsideEntries = await readdir(outsidePath);
    for (const entry of outsideEntries) {
      expect((await lstat(join(outsidePath, entry))).size).toBe(0);
    }
  });

  it('binds final rename to the verified directory when its pathname is swapped', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const backupPath = join(userDataPath, 'rename-backup');
    const outsidePath = join(userDataPath, 'outside-rename-directory');
    const outsideSentinel = 'outside final must remain';
    await mkdir(directoryPath);
    await mkdir(outsidePath);
    let swapped = false;
    let outsideFinalPath = '';
    const swappingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind !== 'rename' || swapped) return;
      swapped = true;
      outsideFinalPath = join(outsidePath, operation.targetName!);
      await writeFile(join(outsidePath, operation.sourceName), 'outside source must remain', 'utf8');
      await writeFile(outsideFinalPath, outsideSentinel, 'utf8');
      await rename(directoryPath, backupPath);
      await symlink(outsidePath, directoryPath, 'dir');
    });

    await expect(swappingStore.write(
      'fixture-conversation',
      new TextEncoder().encode('rename-swap fixture payload'),
    )).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideFinalPath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('rejects a parent identity swap while opening a blob for read', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('read-swap fixture payload'),
    );
    const blobPath = join(userDataPath, 'conversation-evidence', result.blobRef);
    const directoryPath = dirname(blobPath);
    const fileName = result.blobRef.split('/')[1]!;
    const backupPath = join(userDataPath, 'read-backup');
    const outsidePath = join(userDataPath, 'outside-read-directory');
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, fileName), await readFile(blobPath));
    let swapped = false;
    const swappingStore = withFileSystem({
      open: async (target, flags, mode) => {
        if (!swapped && target.toString() === blobPath) {
          swapped = true;
          await rename(directoryPath, backupPath);
          await rename(outsidePath, directoryPath);
        }
        return openFile(target, flags, mode);
      },
    });

    await expect(swappingStore.read(result.blobRef)).rejects.toMatchObject({
      code: 'UNSAFE_STORAGE_PATH',
      message: 'Evidence storage path is unsafe',
    });
  });

  it('finalizes through staging and leaves no staging file behind', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('atomic fixture payload'),
    );
    const directoryPath = dirname(join(userDataPath, 'conversation-evidence', result.blobRef));
    const entries = await readdir(directoryPath);

    expect(entries).toEqual([result.blobRef.split('/')[1]]);
    expect((await lstat(join(userDataPath, 'conversation-evidence', result.blobRef))).isFile()).toBe(
      true,
    );
  });

  it('orders staging fsync, directory fsync, rename, and final directory fsync', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const operations: string[] = [];
    const orderedStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind === 'rename') operations.push('rename');
    }, {
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString().includes('.staging-')) {
          return wrapHandleSync(handle, async () => {
            operations.push('staging-fsync');
            await handle.sync();
          });
        }
        if (target.toString() === directoryPath) {
          return wrapHandleSync(handle, async () => {
            operations.push('directory-fsync');
            await handle.sync();
          });
        }
        return handle;
      },
    });

    await orderedStore.write(
      'fixture-conversation',
      new TextEncoder().encode('ordering fixture payload'),
    );

    expect(operations).toEqual([
      'staging-fsync',
      'directory-fsync',
      'rename',
      'directory-fsync',
    ]);
  });

  it('publishes authenticated metadata after staging fsync and before atomic rename', async () => {
    const observed: string[] = [];
    let stagedRef = '';

    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('prepared metadata fixture payload'),
      async (prepared) => {
        observed.push('prepared');
        stagedRef = prepared.blobRef;
        const finalPath = join(userDataPath, 'conversation-evidence', prepared.blobRef);
        await expect(lstat(finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const entries = await readdir(dirname(finalPath));
        expect(entries.some((entry) => entry.startsWith('.staging-'))).toBe(true);
      },
    );

    expect(observed).toEqual(['prepared']);
    expect(result.blobRef).toBe(stagedRef);
    expect((await lstat(join(userDataPath, 'conversation-evidence', result.blobRef))).isFile())
      .toBe(true);
  });

  it('removes the staging file when prepared-metadata persistence fails', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);

    await expect(store.write(
      'fixture-conversation',
      new TextEncoder().encode('prepared failure fixture payload'),
      async () => { throw new Error('fixture metadata detail'); },
    )).rejects.toMatchObject({
      code: 'BLOB_WRITE_FAILED',
      message: 'Evidence blob write failed',
    });
    await expect(readdir(directoryPath)).resolves.toEqual([]);
  });

  it('does not remove outside data when the directory is swapped during failure cleanup', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const backupPath = join(userDataPath, 'failure-cleanup-backup');
    const outsidePath = join(userDataPath, 'outside-failure-cleanup');
    const outsideSentinel = 'outside staging must remain';
    await mkdir(directoryPath);
    await mkdir(outsidePath);
    let swapped = false;
    let outsideStagePath = '';
    const swappingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind !== 'remove' || swapped) return;
      swapped = true;
      outsideStagePath = join(outsidePath, operation.sourceName);
      await writeFile(outsideStagePath, outsideSentinel, 'utf8');
      await rename(directoryPath, backupPath);
      await symlink(outsidePath, directoryPath, 'dir');
    });

    await expect(swappingStore.write(
      'fixture-conversation',
      new TextEncoder().encode('failure cleanup swap fixture'),
      async () => { throw new Error('fixture metadata detail'); },
    )).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideStagePath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('fails closed when staging fsync fails and does not rename', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    let renamed = false;
    const failingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind === 'rename') renamed = true;
    }, {
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (!target.toString().includes('.staging-')) return handle;
        return wrapHandleSync(handle, async () => { throw createIoError('EIO'); });
      },
    });

    await expect(
      failingStore.write(
        'fixture-conversation',
        new TextEncoder().encode('staging-fsync fixture payload'),
      ),
    ).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
    expect(renamed).toBe(false);
    await expect(readdir(directoryPath)).resolves.toEqual([]);
  });

  it.each([
    ['before rename', 1, 0],
    ['after rename', 2, 1],
  ])('fails closed when directory fsync fails %s', async (_name, failureCall, finalCount) => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    let syncCall = 0;
    const failingStore = withFileSystem({
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString() !== directoryPath) return handle;
        return wrapHandleSync(handle, async () => {
          syncCall += 1;
          if (syncCall === failureCall) throw createIoError('EIO');
          await handle.sync();
        });
      },
    });

    await expect(
      failingStore.write(
        'fixture-conversation',
        new TextEncoder().encode('directory-fsync fixture payload'),
      ),
    ).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
    const entries = await readdir(directoryPath);
    expect(entries.filter((entry) => entry.endsWith('.aioev1'))).toHaveLength(finalCount);
    expect(entries.filter((entry) => entry.includes('.staging-'))).toHaveLength(0);
  });

  it('fails closed when opening the directory for fsync fails', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const failingStore = withFileSystem({
      open: async (target, flags, mode) => {
        if (target.toString() === directoryPath) throw createIoError('EACCES');
        return openFile(target, flags, mode);
      },
    });

    await expect(
      failingStore.write(
        'fixture-conversation',
        new TextEncoder().encode('directory-open fixture payload'),
      ),
    ).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
  });

  it('treats only explicit unsupported directory fsync errors as best effort', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const supportedStore = withFileSystem({
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString() !== directoryPath) return handle;
        return wrapHandleSync(handle, async () => { throw createIoError('EINVAL'); });
      },
    });

    const payload = new TextEncoder().encode('unsupported-fsync fixture payload');
    await expect(supportedStore.write('fixture-conversation', payload)).resolves.toMatchObject({
      byteCount: payload.byteLength,
    });
  });

  it('fails closed on rename failure and removes the staging file', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    const failingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind === 'rename') throw createIoError('EIO');
    });

    await expect(
      failingStore.write(
        'fixture-conversation',
        new TextEncoder().encode('rename fixture payload'),
      ),
    ).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
    await expect(readdir(directoryPath)).resolves.toEqual([]);
  });

  it('preserves prepared metadata state when the following rename fails', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    let prepared: string | null = null;
    const failingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind === 'rename') throw createIoError('EIO');
    });

    await expect(failingStore.write(
      'fixture-conversation',
      new TextEncoder().encode('prepared then rename failure fixture'),
      async (result) => { prepared = result.blobRef; },
    )).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
    expect(prepared).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{32}\.aioev1$/);
    await expect(readdir(directoryPath)).resolves.toEqual([]);
  });

  it('keeps the finalized blob after prepared metadata and final directory fsync failure', async () => {
    const directoryRef = await store.deriveConversationDirectoryRef('fixture-conversation');
    const directoryPath = join(userDataPath, 'conversation-evidence', directoryRef);
    let syncCall = 0;
    let prepared: string | null = null;
    const failingStore = withFileSystem({
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString() !== directoryPath) return handle;
        return wrapHandleSync(handle, async () => {
          syncCall += 1;
          if (syncCall === 2) throw createIoError('EIO');
          await handle.sync();
        });
      },
    });

    await expect(failingStore.write(
      'fixture-conversation',
      new TextEncoder().encode('prepared then final fsync failure fixture'),
      async (result) => { prepared = result.blobRef; },
    )).rejects.toMatchObject({ code: 'BLOB_WRITE_FAILED' });
    expect(prepared).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{32}\.aioev1$/);
    expect((await lstat(join(userDataPath, 'conversation-evidence', prepared!))).isFile()).toBe(true);
    expect((await readdir(directoryPath)).filter((entry) => entry.startsWith('.staging-')))
      .toEqual([]);
  });

  it('removes only grace-aged finalized blobs absent from the complete reference set', async () => {
    const referenced = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('referenced finalized fixture'),
    );
    const orphan = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('orphan finalized fixture'),
    );
    const freshOrphan = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('fresh orphan finalized fixture'),
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(join(userDataPath, 'conversation-evidence', referenced.blobRef), old, old);
    await utimes(join(userDataPath, 'conversation-evidence', orphan.blobRef), old, old);

    const removed = await store.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs: new Set([referenced.blobRef]),
      olderThanMs: 30_000,
    });

    expect(removed).toBe(1);
    await expect(lstat(join(userDataPath, 'conversation-evidence', orphan.blobRef)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(join(userDataPath, 'conversation-evidence', referenced.blobRef))).isFile())
      .toBe(true);
    expect((await lstat(join(userDataPath, 'conversation-evidence', freshOrphan.blobRef))).isFile())
      .toBe(true);
  });

  it('binds finalized-orphan removal to the verified directory when its pathname is swapped', async () => {
    const orphan = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('finalized cleanup swap fixture'),
    );
    const orphanPath = join(userDataPath, 'conversation-evidence', orphan.blobRef);
    const directoryPath = dirname(orphanPath);
    const orphanName = orphan.blobRef.split('/')[1]!;
    const backupPath = join(userDataPath, 'finalized-cleanup-backup');
    const outsidePath = join(userDataPath, 'outside-finalized-cleanup');
    const outsideOrphanPath = join(outsidePath, orphanName);
    const outsideSentinel = 'outside finalized orphan must remain';
    const old = new Date(Date.now() - 60_000);
    await utimes(orphanPath, old, old);
    await mkdir(outsidePath);
    await writeFile(outsideOrphanPath, outsideSentinel, 'utf8');
    let swapped = false;
    const swappingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind !== 'remove' || swapped) return;
      swapped = true;
      await rename(directoryPath, backupPath);
      await symlink(outsidePath, directoryPath, 'dir');
    });

    await expect(swappingStore.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs: new Set(),
      olderThanMs: 0,
    })).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideOrphanPath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('removes stale orphan staging files but preserves finalized blobs and symlinks', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('cleanup fixture payload'),
    );
    const directoryPath = dirname(join(userDataPath, 'conversation-evidence', result.blobRef));
    const staleStage = join(directoryPath, `.staging-${'b'.repeat(32)}.tmp`);
    const freshStage = join(directoryPath, `.staging-${'c'.repeat(32)}.tmp`);
    const linkedStage = join(directoryPath, `.staging-${'d'.repeat(32)}.tmp`);
    await writeFile(staleStage, 'stale fixture', 'utf8');
    await writeFile(freshStage, 'fresh fixture', 'utf8');
    await symlink(join(userDataPath, 'outside-fixture'), linkedStage);
    const old = new Date(Date.now() - 60_000);
    await utimes(staleStage, old, old);

    const removed = await store.cleanupOrphanStagingFiles({ olderThanMs: 30_000 });

    expect(removed).toBe(1);
    await expect(lstat(staleStage)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(freshStage)).isFile()).toBe(true);
    expect((await lstat(linkedStage)).isSymbolicLink()).toBe(true);
    expect((await lstat(join(userDataPath, 'conversation-evidence', result.blobRef))).isFile()).toBe(
      true,
    );
  });

  it('rejects a parent identity swap during orphan cleanup without removing outside data', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('cleanup-swap fixture payload'),
    );
    const directoryPath = dirname(join(userDataPath, 'conversation-evidence', result.blobRef));
    const stageName = `.staging-${'e'.repeat(32)}.tmp`;
    const stagePath = join(directoryPath, stageName);
    const backupPath = join(userDataPath, 'cleanup-backup');
    const outsidePath = join(userDataPath, 'outside-cleanup-directory');
    await writeFile(stagePath, 'stale fixture', 'utf8');
    await mkdir(outsidePath);
    await writeFile(join(outsidePath, stageName), 'outside fixture must remain', 'utf8');
    let swapped = false;
    const swappingStore = withFileSystem({
      lstat: async (target, options) => {
        if (!swapped && target.toString() === stagePath) {
          swapped = true;
          await rename(directoryPath, backupPath);
          await symlink(outsidePath, directoryPath, 'dir');
        }
        return lstat(target, options);
      },
    });

    await expect(
      swappingStore.cleanupOrphanStagingFiles({ olderThanMs: 0 }),
    ).rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    await expect(readFile(join(outsidePath, stageName), 'utf8')).resolves.toBe(
      'outside fixture must remain',
    );
  });

  it('binds orphan removal to the verified directory when its pathname is swapped', async () => {
    const result = await store.write(
      'fixture-conversation',
      new TextEncoder().encode('cleanup-operation-swap fixture payload'),
    );
    const directoryPath = dirname(join(userDataPath, 'conversation-evidence', result.blobRef));
    const stageName = `.staging-${'9'.repeat(32)}.tmp`;
    const stagePath = join(directoryPath, stageName);
    const backupPath = join(userDataPath, 'cleanup-operation-backup');
    const outsidePath = join(userDataPath, 'outside-cleanup-operation');
    const outsideStagePath = join(outsidePath, stageName);
    const outsideSentinel = 'outside orphan must remain';
    await writeFile(stagePath, 'stale fixture', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(stagePath, old, old);
    await mkdir(outsidePath);
    await writeFile(outsideStagePath, outsideSentinel, 'utf8');
    let swapped = false;
    const swappingStore = beforeDirectoryOperation(async (operation) => {
      if (operation.kind !== 'remove' || swapped) return;
      swapped = true;
      await rename(directoryPath, backupPath);
      await symlink(outsidePath, directoryPath, 'dir');
    });

    await expect(swappingStore.cleanupOrphanStagingFiles({ olderThanMs: 0 }))
      .rejects.toMatchObject({ code: 'UNSAFE_STORAGE_PATH' });
    expect(swapped).toBe(true);
    await expect(readFile(outsideStagePath, 'utf8')).resolves.toBe(outsideSentinel);
  });

  it('fsyncs only directories where cleanup removed a staging file', async () => {
    const first = await store.write(
      'fixture-conversation-a',
      new TextEncoder().encode('cleanup first fixture'),
    );
    const second = await store.write(
      'fixture-conversation-b',
      new TextEncoder().encode('cleanup second fixture'),
    );
    const firstDirectory = dirname(join(userDataPath, 'conversation-evidence', first.blobRef));
    const secondDirectory = dirname(join(userDataPath, 'conversation-evidence', second.blobRef));
    const stalePath = join(firstDirectory, `.staging-${'f'.repeat(32)}.tmp`);
    await writeFile(stalePath, 'stale', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await utimes(stalePath, old, old);
    const synced: string[] = [];
    const cleanupStore = withFileSystem({
      open: async (target, flags, mode) => {
        const handle = await openFile(target, flags, mode);
        if (target.toString() !== firstDirectory && target.toString() !== secondDirectory) {
          return handle;
        }
        return wrapHandleSync(handle, async () => {
          synced.push(target.toString());
          await handle.sync();
        });
      },
    });

    await expect(cleanupStore.cleanupOrphanStagingFiles()).resolves.toBe(1);
    expect(synced).toEqual([firstDirectory]);
  });

  it('uses no-follow semantics where the platform provides them', () => {
    expect(constants.O_NOFOLLOW).toBeTypeOf('number');
  });
});
