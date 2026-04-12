/**
 * Generate block-level signatures for a file. The target side computes these
 * and sends them to the source side, which uses them to identify matching
 * blocks and produce a compact delta.
 */

import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import { adler32 } from './rolling-checksum';
import type {
  BlockSignature,
  FileSignatures
} from '../../../shared/types/sync.types';
import { DEFAULT_BLOCK_SIZE } from '../../../shared/types/sync.types';

/**
 * Compute block signatures for a file on disk.
 *
 * Reads the file in `blockSize` chunks and computes:
 * - Adler-32 rolling checksum (weak hash)
 * - SHA-256 digest (strong hash)
 *
 * @param filePath  Absolute path to the file.
 * @param relativePath  The sync-relative path (for the FileSignatures envelope).
 * @param blockSize  Block size in bytes (default 4096).
 */
export async function computeBlockSignatures(
  filePath: string,
  relativePath: string,
  blockSize = DEFAULT_BLOCK_SIZE
): Promise<FileSignatures> {
  const buffer = await fs.readFile(filePath);
  const signatures: BlockSignature[] = [];

  let index = 0;
  let offset = 0;

  while (offset < buffer.length) {
    const end = Math.min(offset + blockSize, buffer.length);
    const block = buffer.subarray(offset, end);

    const weakHash = adler32(block);
    const strongHash = createHash('sha256').update(block).digest('hex');

    signatures.push({
      index,
      offset,
      length: block.length,
      weakHash,
      strongHash
    });

    index++;
    offset = end;
  }

  return {
    relativePath,
    fileSize: buffer.length,
    blockSize,
    signatures
  };
}
