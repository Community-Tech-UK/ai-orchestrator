import { EvidenceStorageError } from './evidence-storage.types';

export const MAX_BOUNDED_BLOB_RESULT_BYTES = 64 * 1024;

export function assertBoundedBlobRange(startByte: number, endByte: number): void {
  if (
    !Number.isSafeInteger(startByte)
    || !Number.isSafeInteger(endByte)
    || startByte < 0
    || endByte <= startByte
    || endByte - startByte > MAX_BOUNDED_BLOB_RESULT_BYTES
  ) {
    throw new EvidenceStorageError('BLOB_READ_FAILED');
  }
}

export class BoundedRangeCollector {
  private readonly parts: Uint8Array[] = [];

  constructor(
    private readonly startByte: number,
    private readonly endByte: number,
  ) {}

  accept(plaintext: Uint8Array, chunkStart: number): void {
    const overlapStart = Math.max(this.startByte, chunkStart);
    const overlapEnd = Math.min(this.endByte, chunkStart + plaintext.byteLength);
    if (overlapEnd <= overlapStart) return;
    this.parts.push(Uint8Array.from(
      plaintext.subarray(overlapStart - chunkStart, overlapEnd - chunkStart),
    ));
  }

  finish(): Uint8Array {
    const result = concatAndZero(this.parts);
    if (result.byteLength === this.endByte - this.startByte) return result;
    result.fill(0);
    throw new EvidenceStorageError('BLOB_DIGEST_MISMATCH');
  }
}

export class BoundedSearchCollector {
  private tail: Buffer = Buffer.alloc(0);
  private matchStart: number | null = null;
  private readonly resultParts: Uint8Array[] = [];
  private retainedBytes = 0;
  private readonly target: Buffer;

  constructor(needle: Uint8Array, private readonly maxResultBytes: number) {
    if (
      needle.byteLength < 1
      || needle.byteLength > 200
      || !Number.isSafeInteger(maxResultBytes)
      || maxResultBytes < needle.byteLength
      || maxResultBytes > MAX_BOUNDED_BLOB_RESULT_BYTES
    ) {
      throw new EvidenceStorageError('BLOB_READ_FAILED');
    }
    this.target = Buffer.from(needle);
  }

  accept(plaintext: Uint8Array, chunkStart: number): void {
    if (this.matchStart !== null) {
      this.retain(plaintext);
      return;
    }
    const combined = Buffer.concat([this.tail, Buffer.from(plaintext)]);
    const combinedStart = chunkStart - this.tail.byteLength;
    const index = combined.indexOf(this.target);
    if (index >= 0) {
      this.matchStart = combinedStart + index;
      this.retain(combined.subarray(index));
      this.replaceTail(Buffer.alloc(0));
      return;
    }
    const carryBytes = Math.min(this.target.byteLength - 1, combined.byteLength);
    this.replaceTail(Buffer.from(combined.subarray(combined.byteLength - carryBytes)));
  }

  finish(): { startByte: number; bytes: Uint8Array } | null {
    this.replaceTail(Buffer.alloc(0));
    return this.matchStart === null
      ? null
      : { startByte: this.matchStart, bytes: concatAndZero(this.resultParts) };
  }

  private retain(bytes: Uint8Array): void {
    if (this.retainedBytes >= this.maxResultBytes) return;
    const take = Math.min(this.maxResultBytes - this.retainedBytes, bytes.byteLength);
    this.resultParts.push(Uint8Array.from(bytes.subarray(0, take)));
    this.retainedBytes += take;
  }

  private replaceTail(next: Buffer): void {
    this.tail.fill(0);
    this.tail = next;
  }
}

function concatAndZero(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
    part.fill(0);
  }
  return result;
}
