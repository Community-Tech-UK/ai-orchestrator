/**
 * Delta generator — the core of the rsync algorithm.
 *
 * Given:
 *   - A source file (the "new" version) on disk
 *   - Block signatures from the target (the "old" version)
 *
 * Produces a compact delta: a list of operations that, when applied to the
 * old file, reconstruct the new file. Operations are either:
 *   - block references (reuse block N from the old file)
 *   - literal bytes (new content not found in the old file)
 *
 * Algorithm:
 * 1. Build a lookup map: weakHash → list of { index, strongHash }
 * 2. Slide a rolling Adler-32 window across the source file
 * 3. At each position, check if the weak hash matches any target block
 * 4. If yes, verify with the strong SHA-256 hash
 * 5. On match → emit a block reference; advance past the block
 * 6. On no match → accumulate the byte into a literal buffer
 */

import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import { RollingChecksum } from './rolling-checksum';
import type {
  FileSignatures,
  FileDelta,
  DeltaOp
} from '../../../shared/types/sync.types';

interface WeakHashEntry {
  index: number;
  strongHash: string;
  length: number;
}

/**
 * Compute a delta for a source file given the target's block signatures.
 *
 * @param sourceFilePath  Absolute path to the source ("new") file.
 * @param targetSigs  Block signatures from the target ("old") file.
 * @returns A FileDelta describing how to reconstruct the source from the target.
 */
export async function computeDelta(
  sourceFilePath: string,
  targetSigs: FileSignatures
): Promise<FileDelta> {
  const sourceBuffer = await fs.readFile(sourceFilePath);
  const blockSize = targetSigs.blockSize;
  const ops: DeltaOp[] = [];

  // Build lookup: weakHash → candidates
  const lookup = new Map<number, WeakHashEntry[]>();
  for (const sig of targetSigs.signatures) {
    const entries = lookup.get(sig.weakHash);
    if (entries) {
      entries.push({
        index: sig.index,
        strongHash: sig.strongHash,
        length: sig.length
      });
    } else {
      lookup.set(sig.weakHash, [
        { index: sig.index, strongHash: sig.strongHash, length: sig.length }
      ]);
    }
  }

  // If the target has no blocks (empty file), everything is literal
  if (targetSigs.signatures.length === 0) {
    if (sourceBuffer.length > 0) {
      ops.push({ type: 'literal', data: sourceBuffer.toString('base64') });
    }
    return makeDelta(targetSigs.relativePath, ops, sourceBuffer);
  }

  // Sliding window scan
  let pos = 0;
  let literalStart = 0;
  const rc = new RollingChecksum();

  // Initialise the rolling checksum with the first window
  const firstWindowEnd = Math.min(blockSize, sourceBuffer.length);
  rc.update(sourceBuffer, 0, firstWindowEnd);

  while (pos <= sourceBuffer.length - blockSize) {
    const weakHash = rc.digest();
    const candidates = lookup.get(weakHash);

    let matched = false;
    if (candidates) {
      // Verify with strong hash
      const windowEnd = Math.min(pos + blockSize, sourceBuffer.length);
      const windowBuf = sourceBuffer.subarray(pos, windowEnd);
      const strongHash = createHash('sha256').update(windowBuf).digest('hex');

      for (const candidate of candidates) {
        if (
          candidate.strongHash === strongHash &&
          candidate.length === windowBuf.length
        ) {
          // Flush any pending literal bytes before this match
          if (pos > literalStart) {
            ops.push({
              type: 'literal',
              data: sourceBuffer.subarray(literalStart, pos).toString('base64')
            });
          }

          ops.push({ type: 'block', index: candidate.index });
          pos += blockSize;
          literalStart = pos;
          matched = true;

          // Re-initialise the rolling checksum at the new position
          if (pos <= sourceBuffer.length - blockSize) {
            rc.reset();
            rc.update(sourceBuffer, pos, blockSize);
          }
          break;
        }
      }
    }

    if (!matched) {
      // Advance by one byte
      if (pos + blockSize < sourceBuffer.length) {
        const oldByte = sourceBuffer[pos];
        const newByte = sourceBuffer[pos + blockSize];
        rc.roll(oldByte, newByte, blockSize);
      }
      pos++;
    }
  }

  // Any remaining bytes after the last match (or from position 0 if no matches)
  if (literalStart < sourceBuffer.length) {
    ops.push({
      type: 'literal',
      data: sourceBuffer.subarray(literalStart).toString('base64')
    });
  }

  return makeDelta(targetSigs.relativePath, ops, sourceBuffer);
}

function makeDelta(
  relativePath: string,
  ops: DeltaOp[],
  sourceBuffer: Buffer
): FileDelta {
  return {
    relativePath,
    ops,
    newSize: sourceBuffer.length,
    newHash: createHash('sha256').update(sourceBuffer).digest('hex')
  };
}

/**
 * Estimate the wire size of a delta (for deciding whether delta transfer
 * saves bandwidth vs full-file transfer).
 */
export function estimateDeltaWireSize(delta: FileDelta): number {
  let size = 0;
  for (const op of delta.ops) {
    if (op.type === 'block') {
      size += 8; // overhead for a block reference
    } else {
      // base64 is ~4/3x the raw bytes
      size += op.data.length;
    }
  }
  return size;
}
