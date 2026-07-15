import { timingSafeEqual } from 'node:crypto';
import { open } from 'node:fs/promises';
import { EvidenceStorageError } from './evidence-storage.types';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export async function readExact(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const result = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(result, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new EvidenceStorageError('BLOB_FORMAT_INVALID');
    offset += bytesRead;
  }
  return result;
}

export function constantTimeHexMatches(actual: Buffer, expectedDigest: string): boolean {
  const wellFormed = DIGEST_PATTERN.test(expectedDigest);
  const expected = wellFormed ? Buffer.from(expectedDigest, 'hex') : Buffer.alloc(actual.byteLength);
  return timingSafeEqual(actual, expected) && wellFormed;
}
