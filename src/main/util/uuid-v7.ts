import { randomBytes } from 'node:crypto';

const UUID_V7_SEQUENCE_BITS = 74n;
const UUID_V7_SEQUENCE_MASK = (1n << UUID_V7_SEQUENCE_BITS) - 1n;
const UUID_V7_RAND_B_MASK = (1n << 62n) - 1n;
const BYTE_MASK = 0xffn;
const UUID_HEX: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

let lastTimestampMs = -1;
let lastSequence = 0n;

export function uuidv7(): string {
  const timestampMs = Math.max(Date.now(), lastTimestampMs);
  let sequence: bigint;

  if (timestampMs === lastTimestampMs) {
    sequence = (lastSequence + 1n) & UUID_V7_SEQUENCE_MASK;
    if (sequence === 0n) {
      lastTimestampMs += 1;
      lastSequence = randomSequence();
      return formatUuidV7(lastTimestampMs, lastSequence);
    }
  } else {
    sequence = randomSequence();
  }

  lastTimestampMs = timestampMs;
  lastSequence = sequence;
  return formatUuidV7(timestampMs, sequence);
}

export function resetUuidv7ForTesting(): void {
  lastTimestampMs = -1;
  lastSequence = 0n;
}

function randomSequence(): bigint {
  const bytes = randomBytes(10);
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value & UUID_V7_SEQUENCE_MASK;
}

function formatUuidV7(timestampMs: number, sequence: bigint): string {
  const bytes = new Uint8Array(16);
  let timestamp = BigInt(timestampMs);

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & BYTE_MASK);
    timestamp >>= 8n;
  }

  const randA = Number((sequence >> 62n) & 0xfffn);
  const randB = sequence & UUID_V7_RAND_B_MASK;

  bytes[6] = 0x70 | (randA >> 8);
  bytes[7] = randA & 0xff;
  bytes[8] = 0x80 | Number((randB >> 56n) & 0x3fn);

  for (let index = 9, shift = 48n; index < 16; index += 1, shift -= 8n) {
    bytes[index] = Number((randB >> shift) & BYTE_MASK);
  }

  return formatUuidBytes(bytes);
}

function formatUuidBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => UUID_HEX[byte]!).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
