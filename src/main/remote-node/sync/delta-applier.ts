/**
 * Delta applier — reconstructs a new file from a delta and the old (base) file.
 *
 * For each DeltaOp:
 *   - 'block'   → copy the referenced block from the base file
 *   - 'literal' → decode base64 and write the literal bytes
 *
 * After reconstruction, verifies size and SHA-256 match the expected values.
 */

import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FileDelta } from '../../../shared/types/sync.types';

export interface ApplyDeltaResult {
  ok: boolean;
  hash: string;
  size: number;
}

/**
 * Apply a delta to reconstruct the new version of a file.
 *
 * @param targetFilePath  Where to write the reconstructed file.
 * @param delta  The delta operations.
 * @param baseFilePath  Path to the old version of the file (for block references).
 *                      If omitted, the delta must consist entirely of literals.
 * @param blockSize  Block size used during signature generation (needed to locate blocks).
 */
export async function applyDelta(
  targetFilePath: string,
  delta: FileDelta,
  baseFilePath?: string,
  blockSize?: number
): Promise<ApplyDeltaResult> {
  let baseBuffer: Buffer | null = null;
  if (baseFilePath) {
    try {
      baseBuffer = await fs.readFile(baseFilePath);
    } catch {
      // Base file may not exist if it was deleted between scan and apply.
      // Block references will fail below if needed.
    }
  }

  const effectiveBlockSize = blockSize ?? 4096;
  const chunks: Buffer[] = [];

  for (const op of delta.ops) {
    if (op.type === 'block') {
      if (!baseBuffer) {
        throw new Error(
          `Delta references block ${op.index} but no base file is available`
        );
      }
      const offset = op.index * effectiveBlockSize;
      const end = Math.min(offset + effectiveBlockSize, baseBuffer.length);
      if (offset >= baseBuffer.length) {
        throw new Error(
          `Delta references block ${op.index} at offset ${offset} but base file is only ${baseBuffer.length} bytes`
        );
      }
      chunks.push(baseBuffer.subarray(offset, end));
    } else {
      chunks.push(Buffer.from(op.data, 'base64'));
    }
  }

  const result = Buffer.concat(chunks);

  // Verify integrity
  const hash = createHash('sha256').update(result).digest('hex');
  if (result.length !== delta.newSize) {
    throw new Error(
      `Size mismatch after applying delta: expected ${delta.newSize}, got ${result.length}`
    );
  }
  if (hash !== delta.newHash) {
    throw new Error(
      `Hash mismatch after applying delta: expected ${delta.newHash}, got ${hash}`
    );
  }

  // Ensure parent directory exists and write the file
  await fs.mkdir(path.dirname(targetFilePath), { recursive: true });
  await fs.writeFile(targetFilePath, result);

  return { ok: true, hash, size: result.length };
}
