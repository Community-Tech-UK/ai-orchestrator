/**
 * acp-stderr-tail.ts
 *
 * Private bounded text tail of a child CLI's stderr, available to callers for
 * inspecting a shutdown trigger. ACP logs only its character count/hash.
 * Retained content uses at most maxChars UTF-16 code units; dump() adds at most
 * maxChunks - 1 newline separators. Suffixes are copied so V8 cannot retain a
 * giant input chunk through a small sliced string.
 */

const DEFAULT_MAX_CHUNKS = 20;
const DEFAULT_MAX_CHARS = 8 * 1024;

export class StderrTailBuffer {
  private readonly chunks: string[] = [];
  private chars = 0;

  constructor(
    private readonly maxChunks: number = DEFAULT_MAX_CHUNKS,
    private readonly maxChars: number = DEFAULT_MAX_CHARS,
  ) {
    if (!Number.isSafeInteger(maxChunks) || maxChunks <= 0 || !Number.isSafeInteger(maxChars) || maxChars <= 0) {
      throw new RangeError('ACP stderr limits must be positive safe integers');
    }
  }

  push(chunk: string): void {
    const trimmed = Buffer.from(chunk.trim().slice(-this.maxChars), 'utf16le').toString('utf16le');
    if (!trimmed) return;
    this.chunks.push(trimmed);
    this.chars += trimmed.length;
    while (
      this.chunks.length > this.maxChunks
      || (this.chars > this.maxChars && this.chunks.length > 1)
    ) {
      const dropped = this.chunks.shift();
      this.chars -= dropped?.length ?? 0;
    }
  }

  /** Joined tail, or undefined when nothing was captured. */
  dump(): string | undefined {
    return this.chunks.length > 0 ? this.chunks.join('\n') : undefined;
  }

  clear(): void {
    this.chunks.length = 0;
    this.chars = 0;
  }
}
