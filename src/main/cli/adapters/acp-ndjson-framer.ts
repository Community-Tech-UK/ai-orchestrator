/** A record ceiling, in UTF-16 characters (at most 8 MiB of string storage).
 * Normal ACP text/tool snapshots can be large; this is deliberately far above
 * ordinary streamed deltas. Oversized records are never partially parsed.
 */
export const MAX_ACP_RECORD_CHARS = 4 * 1024 * 1024;

export class AcpNdjsonFramer {
  private pending = '';
  private discarding = false;

  constructor(private readonly maxRecordChars = MAX_ACP_RECORD_CHARS) {
    if (!Number.isSafeInteger(maxRecordChars) || maxRecordChars <= 0) throw new RangeError('ACP record limit must be a positive safe integer');
  }

  get pendingText(): string { return this.pending; }

  clear(): void {
    this.pending = '';
    this.discarding = false;
  }

  push(chunk: string, onRecord: (record: string) => void, onOversized: (limitChars: number) => void): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf('\n', start);
      const end = newline < 0 ? chunk.length : newline;
      if (!this.discarding) {
        if (this.pending.length + end - start > this.maxRecordChars) {
          this.pending = '';
          this.discarding = true;
          onOversized(this.maxRecordChars);
        } else {
          // A V8 sliced string can keep the entire native chunk alive even
          // when only a short suffix is retained. Copy the bounded fragment;
          // UTF-16 preserves code units split across subsequent chunks.
          this.pending += Buffer.from(chunk.slice(start, end), 'utf16le').toString('utf16le');
        }
      }
      if (newline < 0) return;
      const record = this.discarding ? '' : this.pending.replace(/\r$/, '');
      this.pending = '';
      this.discarding = false;
      start = newline + 1;
      if (record.trim()) onRecord(record);
    }
  }
}
