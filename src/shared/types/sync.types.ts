/**
 * Types for the rsync-style directory synchronization engine.
 *
 * The sync protocol works in four phases:
 * 1. SCANNING  — both sides walk their directory tree and produce a SyncManifest
 * 2. COMPARING — manifests are diffed to identify added/removed/modified files
 * 3. TRANSFERRING — for modified files, block-level deltas minimise bandwidth
 * 4. APPLYING  — target reconstructs files from deltas
 */

// ---------------------------------------------------------------------------
// Manifest — directory-level inventory
// ---------------------------------------------------------------------------

/** A single file entry in a directory manifest. */
export interface SyncFileEntry {
  /** Path relative to the sync root, always forward-slash separated. */
  relativePath: string;
  size: number;
  modifiedAt: number;
  /** SHA-256 hex digest of the full file content. */
  hash: string;
}

/** Complete inventory of all files under a root directory. */
export interface SyncManifest {
  rootPath: string;
  entries: SyncFileEntry[];
  totalSize: number;
  scannedAt: number;
}

/** Parameters for the sync.scanDirectory RPC. */
export interface SyncScanParams {
  path: string;
  exclude?: string[];
}

// ---------------------------------------------------------------------------
// Block signatures — per-file fingerprints for delta transfer
// ---------------------------------------------------------------------------

/** One block's fingerprint within a file. */
export interface BlockSignature {
  /** Block index (0-based). */
  index: number;
  /** Byte offset in the original file. */
  offset: number;
  /** Actual block length (last block may be shorter than blockSize). */
  length: number;
  /** Adler-32 rolling checksum (fast, weak). */
  weakHash: number;
  /** SHA-256 hex digest (strong). */
  strongHash: string;
}

/** All block signatures for a single file. */
export interface FileSignatures {
  relativePath: string;
  fileSize: number;
  blockSize: number;
  signatures: BlockSignature[];
}

/** Parameters for the sync.getBlockSignatures RPC. */
export interface SyncBlockSigParams {
  path: string;
  relativePath: string;
  blockSize: number;
}

// ---------------------------------------------------------------------------
// Delta — instructions for reconstructing a file
// ---------------------------------------------------------------------------

/** Reuse a block from the old (target) file. */
export interface DeltaBlockOp {
  type: 'block';
  /** Index into the target file's BlockSignature array. */
  index: number;
}

/** Literal new bytes not found in the old file (base64-encoded). */
export interface DeltaLiteralOp {
  type: 'literal';
  /** base64-encoded raw bytes. */
  data: string;
}

export type DeltaOp = DeltaBlockOp | DeltaLiteralOp;

/** Delta for a single file. */
export interface FileDelta {
  relativePath: string;
  ops: DeltaOp[];
  /** Expected byte count after applying. */
  newSize: number;
  /** SHA-256 hex digest of the reconstructed file. */
  newHash: string;
}

/** Parameters for the sync.computeDelta RPC. */
export interface SyncComputeDeltaParams {
  path: string;
  targetSignatures: FileSignatures;
}

/** Parameters for the sync.applyDelta RPC. */
export interface SyncApplyDeltaParams {
  path: string;
  delta: FileDelta;
  /** Path to the existing (old) file used for block references. */
  basePath?: string;
}

/** Parameters for the sync.deleteFile RPC. */
export interface SyncDeleteFileParams {
  path: string;
}

// ---------------------------------------------------------------------------
// Directory diff — result of comparing two manifests
// ---------------------------------------------------------------------------

export interface ModifiedEntry {
  relativePath: string;
  sourceEntry: SyncFileEntry;
  targetEntry: SyncFileEntry;
}

export interface DirectoryDiff {
  added: SyncFileEntry[];
  removed: SyncFileEntry[];
  modified: ModifiedEntry[];
  identical: string[];
}

// ---------------------------------------------------------------------------
// Sync job — orchestration parameters and progress
// ---------------------------------------------------------------------------

export interface SyncJobParams {
  sourceNodeId: string;
  sourcePath: string;
  targetNodeId: string;
  targetPath: string;
  /** Remove files from target that don't exist in source (default: false). */
  deleteExtraneous?: boolean;
  /** Glob patterns to exclude from sync. */
  exclude?: string[];
  /** Only compute the diff — don't transfer anything. */
  dryRun?: boolean;
  /** Block size in bytes for delta transfer (default: 4096). */
  blockSize?: number;
}

export type SyncPhase =
  | 'scanning'
  | 'comparing'
  | 'transferring'
  | 'applying'
  | 'complete'
  | 'error'
  | 'cancelled';

export interface SyncProgress {
  jobId: string;
  phase: SyncPhase;
  totalFiles: number;
  processedFiles: number;
  totalBytes: number;
  /** Actual bytes transferred over the wire (after delta compression). */
  transferredBytes: number;
  currentFile?: string;
  error?: string;
}

export interface SyncError {
  relativePath: string;
  error: string;
}

export interface SyncResult {
  jobId: string;
  added: number;
  removed: number;
  modified: number;
  identical: number;
  totalBytesTransferred: number;
  totalBytesLogical: number;
  durationMs: number;
  errors: SyncError[];
  diff?: DirectoryDiff;
}

/** Default block size for delta transfer (4 KB). */
export const DEFAULT_BLOCK_SIZE = 4096;

/** Maximum file size eligible for delta transfer (50 MB). */
export const MAX_DELTA_FILE_SIZE = 50 * 1024 * 1024;
