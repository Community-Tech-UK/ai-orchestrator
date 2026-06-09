import * as fs from 'fs';
import * as fsp from 'fs/promises';

export const LOOP_TEXT_FILE_MAX_BYTES = 128 * 1024;

export interface BoundedUtf8Read {
  text: string;
  truncated: boolean;
  sizeBytes: number;
}

function normalizeMaxBytes(maxBytes: number): number {
  return Math.max(1, Math.floor(maxBytes));
}

export async function readUtf8FileHead(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): Promise<BoundedUtf8Read> {
  const limit = normalizeMaxBytes(maxBytes);
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > bytesRead,
      sizeBytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export async function readUtf8FileTail(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): Promise<BoundedUtf8Read> {
  const limit = normalizeMaxBytes(maxBytes);
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, limit);
    const position = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: position > 0,
      sizeBytes: stat.size,
    };
  } finally {
    await handle.close();
  }
}

export function readUtf8FileHeadSync(
  filePath: string,
  maxBytes = LOOP_TEXT_FILE_MAX_BYTES,
): BoundedUtf8Read {
  const limit = normalizeMaxBytes(maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const bytesToRead = Math.min(stat.size, limit);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: stat.size > bytesRead,
      sizeBytes: stat.size,
    };
  } finally {
    fs.closeSync(fd);
  }
}
