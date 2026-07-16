export type EvidenceStorageErrorCode =
  | 'SAFE_STORAGE_UNAVAILABLE'
  | 'KEYRING_CORRUPT'
  | 'KEYRING_IO_FAILED'
  | 'KEY_VERSION_UNAVAILABLE'
  | 'KEY_VERSION_OVERFLOW'
  | 'UNSAFE_STORAGE_PATH'
  | 'BLOB_REF_INVALID'
  | 'BLOB_NOT_FOUND'
  | 'BLOB_FORMAT_INVALID'
  | 'BLOB_AUTH_FAILED'
  | 'BLOB_DIGEST_MISMATCH'
  | 'BLOB_WRITE_FAILED'
  | 'BLOB_DELETE_FAILED'
  | 'BLOB_READ_FAILED'
  | 'CLEANUP_FAILED';

const ERROR_MESSAGES: Record<EvidenceStorageErrorCode, string> = {
  SAFE_STORAGE_UNAVAILABLE: 'Evidence encryption is unavailable',
  KEYRING_CORRUPT: 'Evidence keyring is corrupt',
  KEYRING_IO_FAILED: 'Evidence keyring operation failed',
  KEY_VERSION_UNAVAILABLE: 'Evidence key version is unavailable',
  KEY_VERSION_OVERFLOW: 'Evidence key version cannot be rotated',
  UNSAFE_STORAGE_PATH: 'Evidence storage path is unsafe',
  BLOB_REF_INVALID: 'Evidence blob reference is invalid',
  BLOB_NOT_FOUND: 'Evidence blob is unavailable',
  BLOB_FORMAT_INVALID: 'Evidence blob format is invalid',
  BLOB_AUTH_FAILED: 'Evidence blob authentication failed',
  BLOB_DIGEST_MISMATCH: 'Evidence blob identity does not match',
  BLOB_WRITE_FAILED: 'Evidence blob write failed',
  BLOB_DELETE_FAILED: 'Evidence blob deletion failed',
  BLOB_READ_FAILED: 'Evidence blob read failed',
  CLEANUP_FAILED: 'Evidence staging cleanup failed',
};

export class EvidenceStorageError extends Error {
  override readonly name = 'EvidenceStorageError';

  constructor(readonly code: EvidenceStorageErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

export interface EvidenceDataKey {
  version: number;
  key: Uint8Array;
  activatedAt: number;
}

export interface EvidenceBlobWriteResult {
  blobRef: string;
  keyedContentId: string;
  byteCount: number;
  keyVersion: number;
}

export interface EvidenceStagingCleanupOptions {
  olderThanMs?: number;
  now?: number;
}

export interface EvidenceFinalizedCleanupOptions extends EvidenceStagingCleanupOptions {
  referencedBlobRefs: ReadonlySet<string>;
}

export interface EvidenceStorageFileSystem {
  lstat: typeof import('node:fs/promises').lstat;
  mkdir: typeof import('node:fs/promises').mkdir;
  open: typeof import('node:fs/promises').open;
  readdir: typeof import('node:fs/promises').readdir;
  realpath: typeof import('node:fs/promises').realpath;
}
