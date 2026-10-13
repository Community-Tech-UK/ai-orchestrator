import { mkdtemp, rm, lstat, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvidenceKeyManager } from './evidence-key-manager';
import { EncryptedEvidenceBlobStore } from './encrypted-evidence-blob-store';

describe('background evidence cleanup ownership', () => {
  let directory: string;
  let keyManager: EvidenceKeyManager;
  let store: EncryptedEvidenceBlobStore;
  const content = new TextEncoder().encode('obvious encrypted fixture');
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'evidence-background-test-'));
    keyManager = new EvidenceKeyManager({ userDataPath: directory, safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (text) => Buffer.from(text),
      decryptString: (bytes) => bytes.toString(),
    } });
    await keyManager.initialize();
    store = new EncryptedEvidenceBlobStore({ userDataPath: directory, keyManager });
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  function path(ref: string) { return join(directory, 'conversation-evidence', ref); }
  async function age(ref: string) {
    const old = new Date(Date.now() - 20 * 60 * 1000);
    await utimes(path(ref), old, old);
  }

  it('keeps a blob referenced after initial enumeration and uses bounded fresh lookups', async () => {
    const blob = await store.write('fixture', content);
    await age(blob.blobRef);
    const batches: string[][] = [];
    const removed = await store.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs: new Set(), olderThanMs: 15 * 60 * 1000,
      findReferencedCandidates: async (refs) => {
        batches.push(refs);
        return [blob.blobRef];
      },
    });
    expect(removed).toBe(0);
    expect(batches).toEqual([[blob.blobRef]]);
    expect(Array.from(await store.read(blob.blobRef, blob.keyedContentId))).toEqual(Array.from(content));
  });

  it('protects an active staging file even when an ongoing write is older than the cutoff', async () => {
    let release!: () => void;
    let staged!: () => void;
    const ready = new Promise<void>((resolve) => { staged = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const writing = store.write('fixture', content, async (blob) => {
      const parent = dirname(path(blob.blobRef));
      const [name] = (await readdir(parent)).filter((entry) => entry.startsWith('.staging-'));
      const old = new Date(Date.now() - 20 * 60 * 1000);
      await utimes(join(parent, name!), old, old);
      staged();
      await pending;
    });
    await ready;
    expect(await store.cleanupOrphanStagingFiles({ olderThanMs: 15 * 60 * 1000 })).toBe(0);
    release();
    const blob = await writing;
    expect(Array.from(await store.read(blob.blobRef, blob.keyedContentId))).toEqual(Array.from(content));
  });

  it('protects the write-to-metadata publication interval even for old finalized files', async () => {
    let release!: () => void;
    let written!: (ref: string) => void;
    const ready = new Promise<string>((resolve) => { written = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const publishing = store.withBlobPublication(async () => {
      const blob = await store.write('fixture', content);
      await age(blob.blobRef);
      written(blob.blobRef);
      await pending;
    });
    const ref = await ready;
    expect(await store.cleanupOrphanFinalizedBlobs({ referencedBlobRefs: new Set(), olderThanMs: 1 })).toBe(0);
    expect((await lstat(path(ref))).isFile()).toBe(true);
    release();
    await publishing;
    expect(await store.cleanupOrphanFinalizedBlobs({ referencedBlobRefs: new Set(), olderThanMs: 1 })).toBe(1);
  });

  it('cancels after a yielding removal hook and leaves the candidate recoverable on restart', async () => {
    const blob = await store.write('fixture', content);
    await age(blob.blobRef);
    const controller = new AbortController();
    const cancellingStore = new EncryptedEvidenceBlobStore({ userDataPath: directory, keyManager,
      beforeDirectoryOperation: async () => { controller.abort(); },
    });
    await expect(cancellingStore.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs: new Set(), signal: controller.signal, olderThanMs: 1,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(Array.from(await store.read(blob.blobRef, blob.keyedContentId))).toEqual(Array.from(content));
    const restarted = new EncryptedEvidenceBlobStore({ userDataPath: directory, keyManager });
    expect(await restarted.cleanupOrphanFinalizedBlobs({ referencedBlobRefs: new Set(), olderThanMs: 1 })).toBe(1);
  });

  it('rechecks age after the removal hook against the fixed sweep cutoff', async () => {
    const blob = await store.write('fixture', content);
    await age(blob.blobRef);
    const sweepTime = Date.now();
    const refreshingStore = new EncryptedEvidenceBlobStore({ userDataPath: directory, keyManager,
      beforeDirectoryOperation: async () => {
        const fresh = new Date(sweepTime + 1);
        await utimes(path(blob.blobRef), fresh, fresh);
      },
    });
    expect(await refreshingStore.cleanupOrphanFinalizedBlobs({
      referencedBlobRefs: new Set(), now: sweepTime, olderThanMs: 1,
    })).toBe(0);
    expect((await lstat(path(blob.blobRef))).isFile()).toBe(true);
  });
});
