const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export interface CliStreamLineParserOptions {
  /** Maximum bytes retained for one incomplete line between chunks. */
  maxBufferBytes?: number;
}

export class CliStreamLineOverflowError extends Error {
  constructor(readonly pendingBytes: number, readonly maxBufferBytes: number) {
    super(`CLI stream line buffer exceeded ${maxBufferBytes} bytes (${pendingBytes} bytes pending).`);
    this.name = 'CliStreamLineOverflowError';
  }
}

/**
 * Transport-agnostic newline deframer for NDJSON/JSONL CLI streams. Parsing
 * stays with each protocol adapter; this class owns only chunk boundaries.
 */
export class CliStreamLineParser {
  private buffer = '';
  private readonly maxBufferBytes: number;

  constructor(options: CliStreamLineParserOptions = {}) {
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    if (!Number.isInteger(maxBufferBytes) || maxBufferBytes < 1) {
      throw new RangeError('maxBufferBytes must be a positive integer.');
    }
    this.maxBufferBytes = maxBufferBytes;
  }

  push(chunk: string | Buffer): string[] {
    const combined = this.buffer + chunk.toString();
    const lines = combined.split('\n');
    this.buffer = lines.pop() ?? '';

    const pendingBytes = this.getPendingByteLength();
    if (pendingBytes > this.maxBufferBytes) {
      this.buffer = '';
      throw new CliStreamLineOverflowError(pendingBytes, this.maxBufferBytes);
    }

    return lines.map(stripTrailingCarriageReturn);
  }

  flush(): string[] {
    if (!this.buffer) {
      return [];
    }
    const line = stripTrailingCarriageReturn(this.buffer);
    this.buffer = '';
    return [line];
  }

  reset(): void {
    this.buffer = '';
  }

  hasPendingData(): boolean {
    return this.buffer.length > 0;
  }

  getPendingByteLength(): number {
    return Buffer.byteLength(this.buffer, 'utf8');
  }
}

function stripTrailingCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
