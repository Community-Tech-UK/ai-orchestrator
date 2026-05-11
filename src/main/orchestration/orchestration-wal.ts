/**
 * Orchestration Write-Ahead Log (WAL).
 *
 * Appends a JSONL record before each orchestration mutation fires.
 * Motivated by mempalace:mcp_server.py (claude2.md section 1.4):
 *   - Rollback capability on crash mid-write
 *   - Audit trail for every state change
 *   - Post-mortem debugging ("why did the agent decide X?")
 *
 * Sensitive keys are redacted before logging so conversation content
 * does not end up in plaintext WAL files.
 *
 * The WAL is append-only and never compacted; rotate logs externally.
 * Default location: <userData>/wal/<YYYY-MM-DD>.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getLogger } from '../logging/logger';

const logger = getLogger('OrchestrationWAL');

/** Keys whose values are replaced with <redacted> in log entries. */
const REDACTED_KEYS = new Set([
  'content',
  'query',
  'text',
  'message',
  'prompt',
  'systemPrompt',
  'apiKey',
  'token',
  'secret',
]);

export type WalEntryKind =
  | 'debate:round-start'
  | 'debate:verdict'
  | 'debate:consensus'
  | 'consensus:query'
  | 'consensus:result'
  | 'child:spawn'
  | 'child:result'
  | 'orchestration:start'
  | 'orchestration:complete'
  | 'orchestration:fail'
  | string;

export interface WalEntry {
  ts: number;
  kind: WalEntryKind;
  instanceId?: string;
  runId?: string;
  payload?: Record<string, unknown>;
}

function redact(obj: unknown, depth = 0): unknown {
  if (depth > 4 || obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = REDACTED_KEYS.has(k) ? '<redacted>' : redact(v, depth + 1);
  }
  return out;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

export class OrchestrationWAL {
  private static instance: OrchestrationWAL | null = null;
  private readonly walDir: string;
  private enabled = true;

  private constructor(walDir?: string) {
    this.walDir =
      walDir ??
      path.join(
        // Electron userData if available, otherwise ~/.aio/wal
        (typeof process !== 'undefined' && process.env['APPDATA']) ||
        path.join(os.homedir(), '.aio', 'wal'),
      );
  }

  static getInstance(walDir?: string): OrchestrationWAL {
    if (!this.instance) this.instance = new OrchestrationWAL(walDir);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** Disable WAL (useful in tests). */
  disable(): void { this.enabled = false; }
  enable(): void { this.enabled = true; }

  append(entry: WalEntry): void {
    if (!this.enabled) return;
    try {
      fs.mkdirSync(this.walDir, { recursive: true });
      const line =
        JSON.stringify({ ...entry, payload: entry.payload ? redact(entry.payload) : undefined }) +
        '\n';
      fs.appendFileSync(path.join(this.walDir, `${todayStr()}.jsonl`), line, 'utf-8');
    } catch (err) {
      logger.warn('WAL append failed', {
        error: err instanceof Error ? err.message : String(err),
        kind: entry.kind,
      });
    }
  }
}

export function getOrchestrationWAL(): OrchestrationWAL {
  return OrchestrationWAL.getInstance();
}
