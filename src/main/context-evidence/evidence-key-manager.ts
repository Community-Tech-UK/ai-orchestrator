import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SafeStorageAccessor } from '../session/safe-storage-accessor';
import {
  EvidenceStorageError,
  type EvidenceDataKey,
  type EvidenceStorageFileSystem,
} from './evidence-storage.types';
import {
  performSecureDirectoryOperation,
  type BeforeDirectoryOperation,
} from './secure-directory-operation';

const STORAGE_DIRECTORY_NAME = 'conversation-evidence';
const KEYRING_FILE_NAME = 'keyring.json';
const KEYRING_FORMAT_VERSION = 1;
const DATA_KEY_BYTES = 32;
const MAX_KEY_VERSION = 0xffff_ffff;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface WrappedKeyEntry {
  version: number;
  wrappedKey: string;
  activatedAt: number;
  retiredAt?: number;
}

interface KeyringFile {
  formatVersion: 1;
  activeKeyVersion: number;
  keys: WrappedKeyEntry[];
}

interface EvidenceKeyManagerOptions {
  userDataPath: string;
  safeStorage: SafeStorageAccessor;
  now?: () => number;
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

export class EvidenceKeyManager {
  private readonly storagePath: string;
  private readonly keyringPath: string;
  private readonly now: () => number;
  private readonly fileSystem: EvidenceStorageFileSystem;
  private readonly keys = new Map<number, EvidenceDataKey>();
  private keyring: KeyringFile | null = null;
  private initialization: Promise<void> | null = null;
  private rotation: Promise<EvidenceDataKey> | null = null;

  constructor(private readonly options: EvidenceKeyManagerOptions) {
    this.storagePath = join(options.userDataPath, STORAGE_DIRECTORY_NAME);
    this.keyringPath = join(this.storagePath, KEYRING_FILE_NAME);
    this.now = options.now ?? Date.now;
    this.fileSystem = { ...NODE_FILE_SYSTEM, ...options.fileSystem };
  }

  async initialize(): Promise<void> {
    if (this.keyring) return;
    if (!this.initialization) {
      this.initialization = this.initializeOnce().catch((error: unknown) => {
        this.initialization = null;
        throw error;
      });
    }
    await this.initialization;
  }

  async getActiveKey(): Promise<EvidenceDataKey> {
    await this.initialize();
    const activeVersion = this.keyring?.activeKeyVersion;
    if (activeVersion === undefined) throw new EvidenceStorageError('KEYRING_CORRUPT');
    return this.copyKey(this.requireKey(activeVersion));
  }

  async getKey(version: number): Promise<Uint8Array> {
    await this.initialize();
    return new Uint8Array(this.requireKey(version).key);
  }

  async rotateKey(): Promise<EvidenceDataKey> {
    if (this.rotation) return this.copyKey(await this.rotation);
    this.rotation = this.rotateOnce().finally(() => {
      this.rotation = null;
    });
    return this.copyKey(await this.rotation);
  }

  private async initializeOnce(): Promise<void> {
    this.assertEncryptionAvailable();
    const directory = await this.ensureSafeStorageDirectory();
    await this.verifyDirectoryIdentity(directory);
    const keyringStat = await this.fileSystem.lstat(this.keyringPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new EvidenceStorageError('KEYRING_IO_FAILED');
    });
    await this.verifyDirectoryIdentity(directory);
    if (!keyringStat) {
      await this.createFirstKeyring(directory);
      return;
    }
    if (!keyringStat.isFile() || keyringStat.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    let raw: string;
    try {
      await this.verifyDirectoryIdentity(directory);
      const handle = await this.fileSystem.open(
        this.keyringPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        await this.verifyDirectoryIdentity(directory);
        const openedStat = await handle.stat();
        if (!openedStat.isFile()) throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
        raw = await handle.readFile('utf8');
        await this.verifyDirectoryIdentity(directory);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof EvidenceStorageError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
        throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
      }
      throw new EvidenceStorageError('KEYRING_IO_FAILED');
    }
    this.loadKeyring(raw);
  }

  private async createFirstKeyring(directory: DirectoryIdentity): Promise<void> {
    const activatedAt = this.now();
    if (!Number.isFinite(activatedAt) || activatedAt < 0) {
      throw new EvidenceStorageError('KEYRING_CORRUPT');
    }
    const key = new Uint8Array(randomBytes(DATA_KEY_BYTES));
    const entry = this.wrapKey(1, key, activatedAt);
    const keyring: KeyringFile = {
      formatVersion: KEYRING_FORMAT_VERSION,
      activeKeyVersion: 1,
      keys: [entry],
    };
    await this.persistKeyring(keyring, directory);
    this.keys.set(1, { version: 1, key, activatedAt });
    this.keyring = keyring;
  }

  private loadKeyring(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new EvidenceStorageError('KEYRING_CORRUPT');
    }
    if (!isKeyringFile(parsed)) throw new EvidenceStorageError('KEYRING_CORRUPT');

    const loaded = new Map<number, EvidenceDataKey>();
    try {
      for (const entry of parsed.keys) {
        const unwrapped = this.options.safeStorage.decryptString(
          Buffer.from(entry.wrappedKey, 'base64'),
        );
        if (!BASE64_PATTERN.test(unwrapped)) throw new Error('invalid wrapped key');
        const key = Buffer.from(unwrapped, 'base64');
        if (key.byteLength !== DATA_KEY_BYTES || key.toString('base64') !== unwrapped) {
          throw new Error('invalid wrapped key');
        }
        loaded.set(entry.version, {
          version: entry.version,
          key: new Uint8Array(key),
          activatedAt: entry.activatedAt,
        });
      }
    } catch {
      throw new EvidenceStorageError('KEYRING_CORRUPT');
    }
    if (!loaded.has(parsed.activeKeyVersion)) throw new EvidenceStorageError('KEYRING_CORRUPT');
    this.keys.clear();
    for (const [version, key] of loaded) this.keys.set(version, key);
    this.keyring = parsed;
  }

  private async rotateOnce(): Promise<EvidenceDataKey> {
    await this.initialize();
    this.assertEncryptionAvailable();
    if (!this.keyring) throw new EvidenceStorageError('KEYRING_CORRUPT');
    const activatedAt = this.now();
    const currentActive = this.keyring.keys.find(
      (entry) => entry.version === this.keyring?.activeKeyVersion,
    );
    if (
      !currentActive ||
      !Number.isFinite(activatedAt) ||
      activatedAt < currentActive.activatedAt
    ) {
      throw new EvidenceStorageError('KEYRING_CORRUPT');
    }
    const highestVersion = this.keyring.keys[this.keyring.keys.length - 1]?.version;
    if (highestVersion === undefined || highestVersion >= MAX_KEY_VERSION) {
      throw new EvidenceStorageError('KEY_VERSION_OVERFLOW');
    }
    const nextVersion = highestVersion + 1;
    const key = new Uint8Array(randomBytes(DATA_KEY_BYTES));
    const nextKeys = this.keyring.keys.map((entry) =>
      entry.version === this.keyring?.activeKeyVersion
        ? { ...entry, retiredAt: activatedAt }
        : { ...entry },
    );
    nextKeys.push(this.wrapKey(nextVersion, key, activatedAt));
    const nextKeyring: KeyringFile = {
      formatVersion: KEYRING_FORMAT_VERSION,
      activeKeyVersion: nextVersion,
      keys: nextKeys,
    };
    if (!isKeyringFile(nextKeyring)) throw new EvidenceStorageError('KEYRING_CORRUPT');
    const directory = await this.captureDirectoryIdentity(this.storagePath);
    await this.persistKeyring(nextKeyring, directory);
    const dataKey = { version: nextVersion, key, activatedAt };
    this.keys.set(nextVersion, dataKey);
    this.keyring = nextKeyring;
    return dataKey;
  }

  private wrapKey(version: number, key: Uint8Array, activatedAt: number): WrappedKeyEntry {
    try {
      const wrapped = this.options.safeStorage.encryptString(Buffer.from(key).toString('base64'));
      if (!Buffer.isBuffer(wrapped) || wrapped.byteLength === 0) {
        throw new Error('invalid wrapped key');
      }
      return { version, wrappedKey: wrapped.toString('base64'), activatedAt };
    } catch {
      throw new EvidenceStorageError('SAFE_STORAGE_UNAVAILABLE');
    }
  }

  private async persistKeyring(
    keyring: KeyringFile,
    directory: DirectoryIdentity,
  ): Promise<void> {
    const tempPath = join(this.storagePath, `.keyring-${randomBytes(16).toString('hex')}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      await this.verifyDirectoryIdentity(directory);
      handle = await this.fileSystem.open(tempPath, 'wx', 0o600);
      await this.verifyDirectoryIdentity(directory);
      await handle.writeFile(`${JSON.stringify(keyring)}\n`, 'utf8');
      await this.verifyDirectoryIdentity(directory);
      await handle.sync();
      await this.verifyDirectoryIdentity(directory);
      await handle.close();
      handle = null;
      await this.syncDirectory(directory);
      await this.verifyDirectoryIdentity(directory);
      await performSecureDirectoryOperation(directory, {
        kind: 'rename',
        sourceName: basename(tempPath),
        targetName: KEYRING_FILE_NAME,
      }, this.options.beforeDirectoryOperation);
      await this.verifyDirectoryIdentity(directory);
      await this.syncDirectory(directory);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      let cleanupError: unknown;
      try {
        await performSecureDirectoryOperation(directory, {
          kind: 'remove',
          sourceName: basename(tempPath),
        }, this.options.beforeDirectoryOperation);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      if (error instanceof EvidenceStorageError) throw error;
      if (cleanupError instanceof EvidenceStorageError) throw cleanupError;
      throw new EvidenceStorageError('KEYRING_IO_FAILED');
    }
  }

  private assertEncryptionAvailable(): void {
    try {
      if (this.options.safeStorage.isEncryptionAvailable()) return;
    } catch {
      // Replaced below with a content-free failure.
    }
    throw new EvidenceStorageError('SAFE_STORAGE_UNAVAILABLE');
  }

  private async ensureSafeStorageDirectory(): Promise<DirectoryIdentity> {
    const existing = await this.fileSystem.lstat(this.storagePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw new EvidenceStorageError('KEYRING_IO_FAILED');
    });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    if (!existing) {
      try {
        await this.fileSystem.mkdir(this.storagePath, { recursive: false, mode: 0o700 });
      } catch {
        const raced = await this.fileSystem.lstat(this.storagePath).catch(() => null);
        if (!raced || !raced.isDirectory() || raced.isSymbolicLink()) {
          throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
        }
      }
    }
    const verified = await this.fileSystem.lstat(this.storagePath).catch(() => null);
    if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
      throw new EvidenceStorageError('UNSAFE_STORAGE_PATH');
    }
    return this.captureDirectoryIdentity(this.storagePath);
  }

  private requireKey(version: number): EvidenceDataKey {
    const key = this.keys.get(version);
    if (!key) throw new EvidenceStorageError('KEY_VERSION_UNAVAILABLE');
    return key;
  }

  private copyKey(key: EvidenceDataKey): EvidenceDataKey {
    return { ...key, key: new Uint8Array(key.key) };
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

  private async syncDirectory(identity: DirectoryIdentity): Promise<void> {
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
      throw new EvidenceStorageError('KEYRING_IO_FAILED');
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
          throw new EvidenceStorageError('KEYRING_IO_FAILED');
        }
      }
      await this.verifyDirectoryIdentity(identity);
    } finally {
      await handle.close();
    }
  }
}

function isKeyringFile(value: unknown): value is KeyringFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record['formatVersion'] !== KEYRING_FORMAT_VERSION ||
    !isValidKeyVersion(record['activeKeyVersion']) ||
    !Array.isArray(record['keys']) ||
    record['keys'].length === 0
  ) {
    return false;
  }
  let previousVersion = 0;
  let previousActivatedAt = Number.NEGATIVE_INFINITY;
  let previousRetiredAt = Number.NEGATIVE_INFINITY;
  let unretiredVersion: number | null = null;
  for (const candidate of record['keys']) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const entry = candidate as Record<string, unknown>;
    if (
      !isValidKeyVersion(entry['version']) ||
      (entry['version'] as number) <= previousVersion ||
      typeof entry['wrappedKey'] !== 'string' ||
      !isCanonicalBase64(entry['wrappedKey']) ||
      typeof entry['activatedAt'] !== 'number' ||
      !Number.isFinite(entry['activatedAt']) ||
      entry['activatedAt'] < 0 ||
      entry['activatedAt'] < previousActivatedAt ||
      entry['activatedAt'] < previousRetiredAt ||
      (entry['retiredAt'] !== undefined &&
        (typeof entry['retiredAt'] !== 'number' ||
          !Number.isFinite(entry['retiredAt']) ||
          entry['retiredAt'] < entry['activatedAt'] ||
          entry['retiredAt'] < previousRetiredAt))
    ) {
      return false;
    }
    if (entry['retiredAt'] === undefined) {
      if (unretiredVersion !== null) return false;
      unretiredVersion = entry['version'] as number;
    }
    previousVersion = entry['version'] as number;
    previousActivatedAt = entry['activatedAt'] as number;
    if (entry['retiredAt'] !== undefined) previousRetiredAt = entry['retiredAt'] as number;
  }
  return (
    unretiredVersion === record['activeKeyVersion'] &&
    record['activeKeyVersion'] === previousVersion
  );
}

function isValidKeyVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_KEY_VERSION;
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    BASE64_PATTERN.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
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
