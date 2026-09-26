/**
 * acp-stderr-tail.ts
 *
 * Bounded in-memory tail of a child CLI's stderr. The ACP adapter feeds every
 * stderr chunk here and logs the tail when the process exits or errors, so the
 * trigger of an otherwise silent shutdown (e.g. the Copilot CLI's raw
 * " Exiting… " marker written by its SIGTERM handler) is preserved in the
 * exit-context record even though live stderr logging stays at debug.
 */

const DEFAULT_MAX_CHUNKS = 20;
const DEFAULT_MAX_BYTES = 8 * 1024;

export class StderrTailBuffer {
  private readonly chunks: string[] = [];
  private bytes = 0;

  constructor(
    private readonly maxChunks: number = DEFAULT_MAX_CHUNKS,
    private readonly maxBytes: number = DEFAULT_MAX_BYTES,
  ) {}

  push(chunk: string): void {
    const trimmed = chunk.trim();
    if (!trimmed) return;
    this.chunks.push(trimmed);
    this.bytes += trimmed.length;
    while (
      this.chunks.length > this.maxChunks
      || (this.bytes > this.maxBytes && this.chunks.length > 1)
    ) {
      const dropped = this.chunks.shift();
      this.bytes -= dropped?.length ?? 0;
    }
  }

  /** Joined tail, or undefined when nothing was captured. */
  dump(): string | undefined {
    return this.chunks.length > 0 ? this.chunks.join('\n') : undefined;
  }

  clear(): void {
    this.chunks.length = 0;
    this.bytes = 0;
  }
}
