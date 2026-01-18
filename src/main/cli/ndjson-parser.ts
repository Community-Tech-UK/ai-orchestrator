/**
 * NDJSON Parser - Parses newline-delimited JSON stream from Claude CLI
 */

import type { CliStreamMessage } from '../../shared/types/cli.types';

// Default max buffer size: 1MB
const DEFAULT_MAX_BUFFER_KB = 1024;

export class NdjsonParser {
  private buffer: string = '';
  private maxBufferBytes: number;

  constructor(maxBufferKB: number = DEFAULT_MAX_BUFFER_KB) {
    this.maxBufferBytes = maxBufferKB * 1024;
  }

  /**
   * Configure the max buffer size
   */
  setMaxBufferSize(maxBufferKB: number): void {
    this.maxBufferBytes = maxBufferKB * 1024;
  }

  /**
   * Get current buffer size in bytes
   */
  getBufferSize(): number {
    return Buffer.byteLength(this.buffer, 'utf-8');
  }

  /**
   * Parse incoming chunk and return complete messages
   */
  parse(chunk: string): CliStreamMessage[] {
    this.buffer += chunk;
    const messages: CliStreamMessage[] = [];

    // Check buffer size limit
    const bufferSize = this.getBufferSize();
    if (bufferSize > this.maxBufferBytes) {
      console.warn(`NDJSON buffer exceeded max size (${bufferSize} > ${this.maxBufferBytes} bytes). Resetting buffer.`);
      // Try to salvage what we can from complete lines
      const lines = this.buffer.split('\n');
      this.buffer = ''; // Reset buffer

      // Parse any complete lines we can salvage
      for (const line of lines.slice(0, -1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as CliStreamMessage;
          parsed.timestamp = parsed.timestamp || Date.now();
          messages.push(parsed);
        } catch {
          // Discard unparseable lines
        }
      }

      return messages;
    }

    // Split by newlines and process complete lines
    const lines = this.buffer.split('\n');

    // Keep the last potentially incomplete line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed) as CliStreamMessage;
        parsed.timestamp = parsed.timestamp || Date.now();
        messages.push(parsed);
      } catch (error) {
        // Log parse errors but continue processing
        console.warn('Failed to parse NDJSON line:', trimmed.substring(0, 100), error);
      }
    }

    return messages;
  }

  /**
   * Flush any remaining buffer content
   */
  flush(): CliStreamMessage[] {
    if (!this.buffer.trim()) {
      this.buffer = '';
      return [];
    }

    try {
      const parsed = JSON.parse(this.buffer.trim()) as CliStreamMessage;
      parsed.timestamp = parsed.timestamp || Date.now();
      this.buffer = '';
      return [parsed];
    } catch {
      // Final content wasn't valid JSON
      console.warn('Discarding incomplete NDJSON buffer:', this.buffer);
      this.buffer = '';
      return [];
    }
  }

  /**
   * Reset parser state
   */
  reset(): void {
    this.buffer = '';
  }

  /**
   * Check if there's pending data in buffer
   */
  hasPendingData(): boolean {
    return this.buffer.trim().length > 0;
  }
}
