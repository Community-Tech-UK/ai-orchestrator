/**
 * Worker-side handler for sync RPC methods.
 *
 * Each method is thin — it validates the path is within the sandbox,
 * then delegates to the pure sync functions.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { isPathAllowed } from './path-sandbox';
import { scanDirectory } from '../main/remote-node/sync/directory-scanner';
import { computeBlockSignatures } from '../main/remote-node/sync/block-signature';
import { computeDelta } from '../main/remote-node/sync/delta-generator';
import { applyDelta } from '../main/remote-node/sync/delta-applier';
import type {
  SyncScanParams,
  SyncManifest,
  SyncBlockSigParams,
  FileSignatures,
  SyncComputeDeltaParams,
  FileDelta,
  SyncApplyDeltaParams,
  SyncDeleteFileParams,
} from '../shared/types/sync.types';

/**
 * Roots the sync tools may touch. `readRoots` is the full readable surface
 * (working directories plus every configured file-transfer root); `writeRoots`
 * is the subset that may be modified. A file-transfer root declared read-only
 * appears in `readRoots` only, so a write to it is refused *as read-only*
 * rather than as "outside allowed roots" (LT-010).
 */
export interface SyncHandlerRoots {
  readRoots: string[];
  writeRoots: string[];
}

export class SyncHandler {
  private readonly readRoots: string[];
  private readonly writeRoots: string[];

  constructor(roots: string[] | SyncHandlerRoots) {
    if (Array.isArray(roots)) {
      // Legacy shape: one allowlist used for both reads and writes.
      this.readRoots = roots;
      this.writeRoots = roots;
    } else {
      this.readRoots = roots.readRoots;
      this.writeRoots = roots.writeRoots;
    }
  }

  private assertReadable(targetPath: string): void {
    if (!isPathAllowed(targetPath, this.readRoots)) {
      throw new Error(`Path outside allowed roots: ${targetPath}`);
    }
  }

  private assertWritable(targetPath: string): void {
    if (isPathAllowed(targetPath, this.writeRoots)) {
      return;
    }
    // Distinguish "you may read here but not write" from "unknown path" so the
    // coordinator can surface an actionable message instead of a sandbox error.
    if (isPathAllowed(targetPath, this.readRoots)) {
      throw new Error(`Path is in a read-only root: ${targetPath}`);
    }
    throw new Error(`Path outside allowed roots: ${targetPath}`);
  }

  async scanDirectory(params: SyncScanParams): Promise<SyncManifest> {
    this.assertReadable(params.path);
    return scanDirectory(params.path, params.exclude);
  }

  async getBlockSignatures(params: SyncBlockSigParams): Promise<FileSignatures> {
    const filePath = path.resolve(params.path, params.relativePath);
    this.assertReadable(filePath);
    return computeBlockSignatures(filePath, params.relativePath, params.blockSize);
  }

  async computeDelta(params: SyncComputeDeltaParams): Promise<FileDelta> {
    const filePath = path.resolve(params.path, params.targetSignatures.relativePath);
    this.assertReadable(filePath);
    return computeDelta(filePath, params.targetSignatures);
  }

  async applyDelta(params: SyncApplyDeltaParams): Promise<{ ok: boolean; hash: string }> {
    const targetFile = path.resolve(params.path, params.delta.relativePath);
    this.assertWritable(targetFile);

    const basePath = params.basePath
      ? path.resolve(params.basePath, params.delta.relativePath)
      : targetFile;

    // If the base file is the same as the target, read it before overwriting
    // Write to a temp file then rename for atomicity
    const tmpPath = targetFile + '.sync-tmp';
    const result = await applyDelta(tmpPath, params.delta, basePath);

    // Atomic rename
    await fs.rename(tmpPath, targetFile);

    return { ok: result.ok, hash: result.hash };
  }

  async deleteFile(params: SyncDeleteFileParams): Promise<{ ok: boolean }> {
    this.assertWritable(params.path);
    try {
      await fs.unlink(params.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // Already gone — that's fine
    }
    return { ok: true };
  }
}
