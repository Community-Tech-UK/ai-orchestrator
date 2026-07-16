import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import type { EvidenceKeyManager } from './evidence-key-manager';
import {
  EvidenceStorageError,
  type EvidenceBlobWriteResult,
  type EvidenceFinalizedCleanupOptions,
  type EvidenceStorageErrorCode,
  type EvidenceStorageFileSystem,
  type EvidenceStagingCleanupOptions,
} from './evidence-storage.types';
import {
  performSecureDirectoryOperation,
  type BeforeDirectoryOperation,
} from './secure-directory-operation';
import {
  assertBoundedBlobRange,
  BoundedRangeCollector,
  BoundedSearchCollector,
} from './evidence-blob-bounded-collector';
import { constantTimeHexMatches, readExact } from './evidence-blob-stream-utils';

const STORAGE_DIRECTORY_NAME = 'conversation-evidence';
const MAGIC = Buffer.from('AIOEV1', 'ascii');
const HEADER_BYTES = MAGIC.byteLength + 4;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MINIMUM_ENVELOPE_BYTES = HEADER_BYTES + NONCE_BYTES + TAG_BYTES;
const STREAM_CHUNK_BYTES = 64 * 1024;
const BLOB_REF_PATTERN = /^[a-f0-9]{64}\/[a-f0-9]{32}\.aioev1$/;
const DIRECTORY_REF_PATTERN = /^[a-f0-9]{64}$/;
const STAGING_FILE_PATTERN = /^\.staging-[a-f0-9]{32}\.tmp$/;
const FINALIZED_FILE_PATTERN = /^[a-f0-9]{32}\.aioev1$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const HKDF_SALT = Buffer.from('AIOEV1/context-evidence/hkdf', 'utf8');

const HKDF_LABELS = {
  content: Buffer.from('AIOEV1/content-identity/v1', 'utf8'),
  citation: Buffer.from('AIOEV1/citation-identity/v1', 'utf8'),
  directory: Buffer.from('AIOEV1/conversation-directory/v1', 'utf8'),
} as const;

interface EncryptedEvidenceBlobStoreOptions {
  userDataPath: string;
  keyManager: EvidenceKeyManager;
  fileSystem?: Partial<EvidenceStorageFileSystem>;
  beforeDirectoryOperation?: BeforeDirectoryOperation;
}

interface DirectoryIdentity {
  path: string;
  realPath: string;
  device: number;
  inode: number;
}

const NODE_FILE_SYSTEM: EvidenceStorageFileSystem = {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
};

export class EncryptedEvidenceBlobStore {
  private readonly storagePath: string;
  private readonly fileSystem: EvidenceStorageFileSystem;

  constructor(private readonly options: EncryptedEvidenceBlobStoreOptions) {
    this.storagePath = join(options.userDataPath, STORAGE_DIRECTORY_NAME);
    this.fileSystem = { ...NODE_FILE_SYSTEM, ...options.fileSystem };
  }

  async write(
    conversationId: string,
    plaintext: Uint8Array,
    onStaged?: (result: EvidenceBlobWriteResult) => Promise<void>,
  ): Promise<EvidenceBlobWriteResult> {
    const ownedPlaintext = Uint8Array.from(plaintext);
    const activeKey = await this.options.keyManager.getActiveKey();
    const root = await this.ensureSafeRoot();
    const directoryRef = this.keyedDigest(
      activeKey.key,
      HKDF_LABELS.directory,
      Buffer.from(conversationId, 'utf8'),
    );
    const directoryPath = join(this.storagePath, directoryRef);
    const directory = await this.ensureSafeDirectory(directoryPath, root);
    const nonce = randomBytes(NONCE_BYTES);
    const header = createHeader(activeKey.version);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(activeKey.key), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(header);
    const plaintextBuffer = Buffer.from(
      ownedPlaintext.buffer,
      ownedPlaintext.byteOffset,
      ownedPlaintext.byteLength,
    );
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();
    const envelope = Buffer.concat([header, nonce, ciphertext, tag]);
    const opaqueName = `${randomBytes(16).toString('hex')}.aioev1`;
    const stagingName = `.staging-${randomBytes(16).toString('hex')}.tmp`;
    const stagingPath = join(directoryPath, stagingName);
    const writeResult: EvidenceBlobWriteResult = {
      blobRef: `${directoryRef}/${opaqueName}`,
      keyedContentId: this.keyedDigest(activeKey.key, HKDF_LABELS.content, plaintextBuffer),
      byteCount: ownedPlaintext.byteLength,
      keyVersion: activeKey.version,
    };
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    let finalized = false;

    try {
      await this.verifyDirectoryIdentity(directory);
      handle = await this.fileSystem.open(stagingPath, 'wx', 0o600);
      await this.verifyDirectoryIdentity(directory);
      const stagingStat = await handle.stat();
      if (!stagingStat.isFile()) throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      await handle.writeFile(envelope);
      await this.verifyDirectoryIdentity(directory);
      await handle.sync();
      await this.verifyDirectoryIdentity(directory);
      await handle.close();
      handle = null;
      await this.syncDirectory(directory, 'BLOB_WRITE_FAILED');
      await this.verifyDirectoryIdentity(directory);
      await onStaged?.(writeResult);
      await this.verifyDirectoryIdentity(directory);
      await performSecureDirectoryOperation(directory, {
        kind: 'rename',
        sourceName: stagingName,
        targetName: opaqueName,
      }, this.options.beforeDirectoryOperation);
      finalized = true;
      await this.verifyDirectoryIdentity(directory);
      await this.syncDirectory(directory, 'BLOB_WRITE_FAILED');
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      let cleanupError: unknown;
      if (!finalized) {
        try {
          await performSecureDirectoryOperation(directory, {
            kind: 'remove',
            sourceName: stagingName,
          }, this.options.beforeDirectoryOperation);
        } catch (cleanupFailure) {
          cleanupError = cleanupFailure;
        }
      }
      if (error instanceof EvidenceStorageError) throw error;
      if (cleanupError instanceof EvidenceStorageError) throw cleanupError;
      throw new EvidenceStorageError('BLOB_WRITE_FAILED');
    }

    return writeResult;
  }

  async read(blobRef: string, expectedKeyedContentId?: string): Promise<Uint8Array> {
    const { blobPath, root, parent } = await this.resolveSafeBlobPath(blobRef);
    let envelope: Buffer;
    try {
      await this.verifyDirectoryIdentity(root);
      await this.verifyDirectoryIdentity(parent);
      const handle = await this.fileSystem.open(
        blobPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await this.verifyDirectoryIdentity(root);
        await this.verifyDirectoryIdentity(parent);
        const stat = await handle.stat();
        if (!stat.isFile()) throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
        envelope = await handle.readFile();
        await this.verifyDirectoryIdentity(root);
        await this.verifyDirectoryIdentity(parent);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      if (
        !await this.isDirectoryIdentityCurrent(root) ||
        !await this.isDirectoryIdentityCurrent(parent)
      ) {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EvidenceStorageError('BLOB_NOT_FOUND');
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      throw new EvidenceStorageError('BLOB_READ_FAILED');
    }

    const parsed = parseEnvelope(envelope);
    const key = await this.options.keyManager.getKey(parsed.keyVersion);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), parsed.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(parsed.header);
      decipher.setAuthTag(parsed.tag);
      plaintext = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    } catch {
      throw new EvidenceStorageError('BLOB_AUTH_FAILED');
    }
    if (
      expectedKeyedContentId !== undefined &&
      !this.constantTimeIdentityMatches(key, HKDF_LABELS.content, plaintext, expectedKeyedContentId)
    ) {
      throw new EvidenceStorageError('BLOB_DIGEST_MISMATCH');
    }
    return new Uint8Array(plaintext);
  }

  async readRange(
    blobRef: string,
    expectedKeyedContentId: string,
    startByte: number,
    endByte: number,
  ): Promise<Uint8Array> {
    assertBoundedBlobRange(startByte, endByte);
    const collector = new BoundedRangeCollector(startByte, endByte);
    await this.scanAuthenticated(blobRef, expectedKeyedContentId, (chunk, offset) => {
      collector.accept(chunk, offset);
    });
    return collector.finish();
  }

  async find(
    blobRef: string,
    expectedKeyedContentId: string,
    needle: Uint8Array,
    maxResultBytes: number,
  ): Promise<{ startByte: number; bytes: Uint8Array } | null> {
    const collector = new BoundedSearchCollector(needle, maxResultBytes);
    await this.scanAuthenticated(blobRef, expectedKeyedContentId, (chunk, offset) => {
      collector.accept(chunk, offset);
    });
    return collector.finish();
  }

  async remove(blobRef: string): Promise<void> {
    const { root, parent } = await this.resolveSafeBlobPath(blobRef);
    const blobName = basename(blobRef);
    try {
      await this.verifyDirectoryIdentity(root);
      await this.verifyDirectoryIdentity(parent);
      await performSecureDirectoryOperation(parent, {
        kind: 'remove',
        sourceName: blobName,
      }, this.options.beforeDirectoryOperation);
      await this.verifyDirectoryIdentity(root);
      await this.verifyDirectoryIdentity(parent);
      await this.syncDirectory(parent, 'BLOB_DELETE_FAILED');
    } catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      throw new EvidenceStorageError('BLOB_DELETE_FAILED');
    }
  }

  async deriveConversationDirectoryRef(conversationId: string, keyVersion?: number): Promise<string> {
    const key = await this.getIdentityKey(keyVersion);
    return this.keyedDigest(
      key,
      HKDF_LABELS.directory,
      Buffer.from(conversationId, 'utf8'),
    );
  }

  async deriveContentId(content: Uint8Array, keyVersion?: number): Promise<string> {
    const key = await this.getIdentityKey(keyVersion);
    return this.keyedDigest(key, HKDF_LABELS.content, asBuffer(content));
  }

  async deriveCitationDigest(content: Uint8Array, keyVersion?: number): Promise<string> {
    const key = await this.getIdentityKey(keyVersion);
    return this.keyedDigest(key, HKDF_LABELS.citation, asBuffer(content));
  }

  async verifyCitationDigest(
    content: Uint8Array,
    expectedDigest: string,
    keyVersion?: number,
  ): Promise<boolean> {
    const key = await this.getIdentityKey(keyVersion);
    return this.constantTimeIdentityMatches(
      key,
      HKDF_LABELS.citation,
      asBuffer(content),
      expectedDigest,
    );
  }

  async cleanupOrphanStagingFiles(options: EvidenceStagingCleanupOptions = {}): Promise<number> {
    return this.cleanupFiles(
      (_directoryRef, name) => STAGING_FILE_PATTERN.test(name),
      options,
    );
  }

  async cleanupOrphanFinalizedBlobs(options: EvidenceFinalizedCleanupOptions): Promise<number> {
    return this.cleanupFiles(
      (directoryRef, name) => FINALIZED_FILE_PATTERN.test(name)
        && !options.referencedBlobRefs.has(`${directoryRef}/${name}`),
      options,
    );
  }

  private async cleanupFiles(
    shouldRemove: (directoryRef: string, name: string) => boolean,
    options: EvidenceStagingCleanupOptions,
  ): Promise<number> {
    const olderThanMs = Math.max(0, options.olderThanMs ?? 0);
    const cutoff = (options.now ?? Date.now()) - olderThanMs;
    const root = await this.ensureSafeRoot();
    let removed = 0;
    try {
      await this.verifyDirectoryIdentity(root);
      const directories = await this.fileSystem.readdir(this.storagePath, { withFileTypes: true });
      await this.verifyDirectoryIdentity(root);
      for (const directory of directories) {
        if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
        if (!DIRECTORY_REF_PATTERN.test(directory.name)) continue;
        const directoryPath = join(this.storagePath, directory.name);
        await this.verifyDirectoryIdentity(root);
        const directoryIdentity = await this.captureDirectoryIdentity(directoryPath);
        if (!isPathInside(directoryIdentity.realPath, root.realPath)) {
          throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
        }
        await this.verifyDirectoryIdentity(directoryIdentity);
        const entries = await this.fileSystem.readdir(directoryPath, { withFileTypes: true });
        await this.verifyDirectoryIdentity(directoryIdentity);
        let removedFromDirectory = false;
        for (const entry of entries) {
          if (!entry.isFile() || entry.isSymbolicLink() || !shouldRemove(directory.name, entry.name)) {
            continue;
          }
          const candidatePath = join(directoryPath, entry.name);
          await this.verifyDirectoryIdentity(directoryIdentity);
          const stat = await this.fileSystem.lstat(candidatePath);
          await this.verifyDirectoryIdentity(directoryIdentity);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs > cutoff) continue;
          await this.verifyDirectoryIdentity(directoryIdentity);
          await performSecureDirectoryOperation(directoryIdentity, {
            kind: 'remove',
            sourceName: entry.name,
          }, this.options.beforeDirectoryOperation);
          await this.verifyDirectoryIdentity(directoryIdentity);
          removed += 1;
          removedFromDirectory = true;
        }
        if (removedFromDirectory) {
          await this.syncDirectory(directoryIdentity, 'CLEANUP_FAILED');
        }
      }
      return removed;
    } catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      throw new EvidenceStorageError('CLEANUP_FAILED');
    }
  }

  private keyedDigest(key: Uint8Array, label: Buffer, content: Buffer): string {
    return this.createKeyedHmac(key, label).update(content).digest('hex');
  }

  private createKeyedHmac(key: Uint8Array, label: Buffer) {
    const hmacKey = Buffer.from(hkdfSync('sha256', Buffer.from(key), HKDF_SALT, label, 32));
    return createHmac('sha256', hmacKey);
  }

  private async scanAuthenticated(
    blobRef: string,
    expectedKeyedContentId: string,
    onPlaintext: (chunk: Uint8Array, startByte: number) => void,
  ): Promise<void> {
    const { blobPath, root, parent } = await this.resolveSafeBlobPath(blobRef);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await this.verifyDirectoryIdentity(root);
      await this.verifyDirectoryIdentity(parent);
      handle = await this.fileSystem.open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      if (stat.size < MINIMUM_ENVELOPE_BYTES) {
        throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
      }
      const prefix = await readExact(handle, 0, HEADER_BYTES + NONCE_BYTES);
      const tag = await readExact(handle, stat.size - TAG_BYTES, TAG_BYTES);
      const header = prefix.subarray(0, HEADER_BYTES);
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
      }
      const keyVersion = header.readUInt32BE(MAGIC.byteLength);
      if (keyVersion < 1) throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
      const key = await this.options.keyManager.getKey(keyVersion);
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(key),
        prefix.subarray(HEADER_BYTES),
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(header);
      decipher.setAuthTag(tag);
      const contentIdentity = this.createKeyedHmac(key, HKDF_LABELS.content);
      const ciphertextStart = HEADER_BYTES + NONCE_BYTES;
      const ciphertextBytes = stat.size - ciphertextStart - TAG_BYTES;
      let ciphertextOffset = 0;
      let plaintextOffset = 0;
      try {
        while (ciphertextOffset < ciphertextBytes) {
          const chunkBytes = Math.min(STREAM_CHUNK_BYTES, ciphertextBytes - ciphertextOffset);
          const ciphertext = await readExact(
            handle,
            ciphertextStart + ciphertextOffset,
            chunkBytes,
          );
          const plaintext = decipher.update(ciphertext);
          contentIdentity.update(plaintext);
          onPlaintext(plaintext, plaintextOffset);
          plaintextOffset += plaintext.byteLength;
          ciphertextOffset += ciphertext.byteLength;
          plaintext.fill(0);
        }
        const finalPlaintext = decipher.final();
        if (finalPlaintext.byteLength > 0) {
          contentIdentity.update(finalPlaintext);
          onPlaintext(finalPlaintext, plaintextOffset);
          finalPlaintext.fill(0);
        }
      } catch (error) {
        if (error instanceof EvidenceStorageError) throw error;
        throw new EvidenceStorageError('BLOB_AUTH_FAILED');
      }
      const actualIdentity = contentIdentity.digest();
      if (!constantTimeHexMatches(actualIdentity, expectedKeyedContentId)) {
        throw new EvidenceStorageError('BLOB_DIGEST_MISMATCH');
      }
      await this.verifyDirectoryIdentity(root);
      await this.verifyDirectoryIdentity(parent);
    } catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      if (
        !await this.isDirectoryIdentityCurrent(root)
        || !await this.isDirectoryIdentityCurrent(parent)
      ) {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new EvidenceStorageError('BLOB_NOT_FOUND');
      }
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      throw new EvidenceStorageError('BLOB_READ_FAILED');
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async getIdentityKey(keyVersion?: number): Promise<Uint8Array> {
    if (keyVersion !== undefined) return this.options.keyManager.getKey(keyVersion);
    return (await this.options.keyManager.getActiveKey()).key;
  }

  private constantTimeIdentityMatches(
    key: Uint8Array,
    label: Buffer,
    content: Buffer,
    expectedDigest: string,
  ): boolean {
    const actual = Buffer.from(this.keyedDigest(key, label, content), 'hex');
    const wellFormed = DIGEST_PATTERN.test(expectedDigest);
    const expected = wellFormed ? Buffer.from(expectedDigest, 'hex') : Buffer.alloc(actual.byteLength);
    return timingSafeEqual(actual, expected) && wellFormed;
  }

  private async ensureSafeRoot(): Promise<DirectoryIdentity> {
    const existing = await this.fileSystem.lstat(this.storagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new EvidenceStorageError('BLOB_WRITE_FAILED');
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    if (!existing) {
      await this.fileSystem.mkdir(this.storagePath, { recursive: false, mode: 0o700 }).catch(() => undefined);
    }
    const verified = await this.fileSystem.lstat(this.storagePath).catch(() => null);
    if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    return this.captureDirectoryIdentity(this.storagePath);
  }

  private async ensureSafeDirectory(
    directoryPath: string,
    root: DirectoryIdentity,
  ): Promise<DirectoryIdentity> {
    await this.verifyDirectoryIdentity(root);
    const existing = await this.fileSystem.lstat(directoryPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new EvidenceStorageError('BLOB_WRITE_FAILED');
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    if (!existing) {
      await this.fileSystem.mkdir(directoryPath, { recursive: false, mode: 0o700 }).catch(() => undefined);
    }
    await this.verifyDirectoryIdentity(root);
    const verified = await this.fileSystem.lstat(directoryPath).catch(() => null);
    if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    const directory = await this.captureDirectoryIdentity(directoryPath);
    if (!isPathInside(directory.realPath, root.realPath)) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    return directory;
  }

  private async resolveSafeBlobPath(blobRef: string): Promise<{
    blobPath: string;
    root: DirectoryIdentity;
    parent: DirectoryIdentity;
  }> {
    if (!BLOB_REF_PATTERN.test(blobRef) || isAbsolute(blobRef)) {
      throw new EvidenceStorageError('BLOB_REF_INVALID');
    }
    const root = await this.ensureSafeRoot();
    const blobPath = join(this.storagePath, blobRef);
    const parentPath = join(this.storagePath, blobRef.split('/')[0] as string);
    await this.verifyDirectoryIdentity(root);
    const parentStat = await this.fileSystem.lstat(parentPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new EvidenceStorageError('BLOB_NOT_FOUND');
      throw new EvidenceStorageError('BLOB_READ_FAILED');
    });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    const parent = await this.captureDirectoryIdentity(parentPath);
    if (!isPathInside(parent.realPath, root.realPath)) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    await this.verifyDirectoryIdentity(parent);
    const blobStat = await this.fileSystem.lstat(blobPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new EvidenceStorageError('BLOB_NOT_FOUND');
      throw new EvidenceStorageError('BLOB_READ_FAILED');
    });
    if (!blobStat.isFile() || blobStat.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    await this.verifyDirectoryIdentity(root);
    await this.verifyDirectoryIdentity(parent);
    return { blobPath, root, parent };
  }

  private async captureDirectoryIdentity(directoryPath: string): Promise<DirectoryIdentity> {
    const stat = await this.fileSystem.lstat(directoryPath).catch(() => null);
    const canonical = await this.fileSystem.realpath(directoryPath).catch(() => null);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !canonical) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    return {
      path: directoryPath,
      realPath: canonical,
      device: stat.dev,
      inode: stat.ino,
    };
  }

  private async verifyDirectoryIdentity(identity: DirectoryIdentity): Promise<void> {
    const current = await this.captureDirectoryIdentity(identity.path);
    if (
      current.realPath !== identity.realPath ||
      current.device !== identity.device ||
      current.inode !== identity.inode
    ) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
  }

  private async isDirectoryIdentityCurrent(identity: DirectoryIdentity): Promise<boolean> {
    try {
      await this.verifyDirectoryIdentity(identity);
      return true;
    } catch {
      return false;
    }
  }

  private async syncDirectory(
    identity: DirectoryIdentity,
    failureCode: Extract<
      EvidenceStorageErrorCode,
      'BLOB_WRITE_FAILED' | 'BLOB_DELETE_FAILED' | 'CLEANUP_FAILED'
    >,
  ): Promise<void> {
    await this.verifyDirectoryIdentity(identity);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await this.fileSystem.open(
        identity.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (isUnsupportedDirectorySyncError(error)) {
        await this.verifyDirectoryIdentity(identity);
        return;
      }
      throw new EvidenceStorageError(failureCode);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isDirectory() || stat.dev !== identity.device || stat.ino !== identity.inode) {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      await this.verifyDirectoryIdentity(identity);
      try {
        await handle.sync();
      } catch (error) {
        if (!isUnsupportedDirectorySyncError(error)) {
          throw new EvidenceStorageError(failureCode);
        }
      }
      await this.verifyDirectoryIdentity(identity);
    } finally {
      await handle.close();
    }
  }
}

function createHeader(keyVersion: number): Buffer {
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 0xffff_ffff) {
    throw new EvidenceStorageError('KEY_VERSION_UNAVAILABLE');
  }
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt32BE(keyVersion, MAGIC.byteLength);
  return header;
}

function parseEnvelope(envelope: Buffer): {
  header: Buffer;
  keyVersion: number;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
} {
  if (envelope.byteLength < MINIMUM_ENVELOPE_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
  }
  const header = envelope.subarray(0, HEADER_BYTES);
  const keyVersion = header.readUInt32BE(MAGIC.byteLength);
  if (keyVersion < 1) throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
  const nonce = envelope.subarray(HEADER_BYTES, HEADER_BYTES + NONCE_BYTES);
  const tag = envelope.subarray(envelope.byteLength - TAG_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES + NONCE_BYTES, envelope.byteLength - TAG_BYTES);
  return { header, keyVersion, nonce, ciphertext, tag };
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function isPathInside(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'EINVAL' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'EISDIR' ||
    (process.platform === 'win32' && code === 'EPERM')
  );
}
