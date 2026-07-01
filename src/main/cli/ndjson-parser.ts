/**
 * NDJSON Parser - Parses newline-delimited JSON stream from Claude CLI
 */

import type { CliStreamMessage } from '../../shared/types/cli.types';
import { getLogger } from '../logging/logger';
import { parseNdjsonLine, parseStreamingJson } from './json-parse';

const logger = getLogger('NdjsonParser');

// Default max buffer size: 1MB
const DEFAULT_MAX_BUFFER_KB = 1024;

function normalizeTimestamp(timestamp: unknown): number {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp >= 0) {
    return timestamp;
  }
  if (typeof timestamp === 'string') {
    const numeric = Number(timestamp);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric;
    }
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasPartialMessagePayload(message: CliStreamMessage): boolean {
  const record = message as unknown as Record<string, unknown>;
  return Object.keys(record).some((key) => key !== 'type' && key !== 'timestamp');
}

function parseIssue(result: ReturnType<typeof parseNdjsonLine<CliStreamMessage>>): string {
  return result.ok ? 'Parsed NDJSON value was not an object' : result.error;
}

export class NdjsonParser {
  private buffer = '';
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
      logger.warn('NDJSON buffer exceeded max size, attempting recovery', {
        bufferSize,
        maxBufferBytes: this.maxBufferBytes,
        bufferPreview: this.buffer.substring(0, 200)
      });

      // Try to salvage complete lines from the oversized buffer
      const lines = this.buffer.split('\n');

      // Preserve the last (potentially incomplete) line instead of discarding it
      this.buffer = lines[lines.length - 1] || '';

      // Parse all complete lines we can salvage
      for (const line of lines.slice(0, -1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const result = parseNdjsonLine<CliStreamMessage>(trimmed);
        if (result.ok && isObject(result.value)) {
          const parsed = result.value;
          parsed.timestamp = normalizeTimestamp(parsed.timestamp);
          messages.push(parsed);
        } else {
          logger.warn('Failed to parse NDJSON line during buffer overflow recovery', {
            linePreview: trimmed.substring(0, 100),
            error: parseIssue(result)
          });
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

      const result = parseNdjsonLine<CliStreamMessage>(trimmed);
      if (result.ok && isObject(result.value)) {
        const parsed = result.value;
        parsed.timestamp = normalizeTimestamp(parsed.timestamp);

        // Log input_required and elicitation messages specifically for debugging
        if (parsed.type === 'input_required' || parsed.type === 'elicitation') {
          logger.debug(`Detected ${parsed.type} message`, { rawLine: trimmed, parsed });
        }

        messages.push(parsed);
      } else {
        // Log parse errors but continue processing
        logger.warn('Failed to parse NDJSON line', { linePreview: trimmed.substring(0, 100), error: parseIssue(result) });
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

    const result = parseStreamingJson<CliStreamMessage>(this.buffer.trim());
    if (result.ok && isObject(result.value) && (!result.partial || hasPartialMessagePayload(result.value))) {
      const parsed = result.value;
      parsed.timestamp = normalizeTimestamp(parsed.timestamp);
      this.buffer = '';
      return [parsed];
    }

    // Final content wasn't valid enough to recover.
    logger.warn('Discarding incomplete NDJSON buffer', {
      buffer: this.buffer,
      ...(!result.ok ? { error: result.error } : {}),
    });
    this.buffer = '';
    return [];
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
