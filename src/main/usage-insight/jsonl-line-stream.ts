/**
 * Reads a growing JSONL file from a byte offset, one complete line at a time.
 *
 * - Lines are cut on the newline byte, so a multi-byte character is never split.
 * - A final line with no newline yet is left alone: the returned offsets only ever
 *   point just after a newline, so the next call picks the line up whole.
 * - A single line longer than `maxLineBytes` is skipped (reported as `null`) rather
 *   than held in memory.
 */

import { createReadStream } from 'node:fs';

export interface LineStreamOptions {
  /** Absolute byte offset to start from. Must be the start of a line. */
  start: number;
  chunkBytes: number;
  maxLineBytes: number;
  signal?: AbortSignal;
  /**
   * Called for each complete line with the offset just after its newline.
   * `line` is null when the line was longer than `maxLineBytes` and was skipped.
   */
  onLine(line: Buffer | null, endOffset: number): void;
  /** Called after each chunk is handled; may await to hand time back to the app. */
  onChunk?(bytes: number): Promise<void>;
}

export async function streamLines(path: string, options: LineStreamOptions): Promise<void> {
  const stream = createReadStream(path, { start: options.start, highWaterMark: options.chunkBytes });
  let position = options.start;
  let parts: Buffer[] = [];
  let partsBytes = 0;
  let skipping = false;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (options.signal?.aborted) {
      stream.destroy();
      return;
    }
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        if (!skipping && chunk.length > start) {
          parts.push(chunk.subarray(start));
          partsBytes += chunk.length - start;
          if (partsBytes > options.maxLineBytes) {
            skipping = true;
            parts = [];
            partsBytes = 0;
          }
        }
        break;
      }
      const endOffset = position + newline + 1;
      if (skipping) {
        skipping = false;
        options.onLine(null, endOffset);
      } else {
        const line = parts.length > 0
          ? Buffer.concat([...parts, chunk.subarray(start, newline)])
          : chunk.subarray(start, newline);
        parts = [];
        partsBytes = 0;
        options.onLine(line.length > options.maxLineBytes ? null : line, endOffset);
      }
      start = newline + 1;
    }
    position += chunk.length;
    await options.onChunk?.(chunk.length);
  }
}
