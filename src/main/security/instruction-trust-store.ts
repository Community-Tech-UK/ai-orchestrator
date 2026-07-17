/**
 * Fable WS12 — hash-pinned trust store for project-sourced instruction files
 * (CLAUDE.md / AGENTS.md / GEMINI.md / .orchestrator/INSTRUCTIONS.md …).
 *
 * A file is `approved` when a pin exists for its canonical path AND the pinned
 * sha256 matches the current content; `changed` when a pin exists but the
 * hash differs; `unknown` when never approved. The resolver consults this in
 * warn-mode (load + surface) or enforce-mode (skip, not warn — rtk semantics).
 *
 * User-global files (~/.claude/CLAUDE.md, AIO-owned resources) are exempt by
 * design — the gate covers *project-sourced* files only; the resolver applies
 * that scoping.
 */

import * as crypto from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';

export type InstructionTrustVerdict = 'approved' | 'changed' | 'unknown';

export interface InstructionTrustPin {
  canonicalPath: string;
  sha256: string;
  approvedAt: number;
  source: 'user';
}

const INSTRUCTION_FILE_TRUST_SCHEMA = `
  CREATE TABLE IF NOT EXISTS instruction_file_trust (
    canonical_path TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'user'
  );
`;

/** Reusable DDL for the migration and direct in-memory store tests. */
export function createInstructionTrustSchema(db: SqliteDriver): void {
  db.exec(INSTRUCTION_FILE_TRUST_SCHEMA);
}

export function sha256OfContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export class InstructionTrustStore {
  private static instance: InstructionTrustStore | null = null;

  constructor(private readonly db: SqliteDriver) {}

  static getInstance(db: SqliteDriver = getRLMDatabase().getRawDb()): InstructionTrustStore {
    if (!InstructionTrustStore.instance) {
      InstructionTrustStore.instance = new InstructionTrustStore(db);
    }
    return InstructionTrustStore.instance;
  }

  static _resetForTesting(): void {
    InstructionTrustStore.instance = null;
  }

  /** Evaluate a file's trust against its pin. */
  evaluate(canonicalPath: string, sha256: string): InstructionTrustVerdict {
    const row = this.db
      .prepare('SELECT sha256 FROM instruction_file_trust WHERE canonical_path = ?')
      .get(canonicalPath) as { sha256: string } | undefined;
    if (!row) return 'unknown';
    return row.sha256 === sha256 ? 'approved' : 'changed';
  }

  /** Pin (approve) a file at its current hash. Errors fail-secure to untrusted. */
  approve(canonicalPath: string, sha256: string): InstructionTrustPin {
    const pin: InstructionTrustPin = {
      canonicalPath,
      sha256,
      approvedAt: Date.now(),
      source: 'user',
    };
    this.db
      .prepare(
        `INSERT INTO instruction_file_trust (canonical_path, sha256, approved_at, source)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(canonical_path) DO UPDATE SET
           sha256 = excluded.sha256,
           approved_at = excluded.approved_at,
           source = excluded.source`,
      )
      .run(pin.canonicalPath, pin.sha256, pin.approvedAt, pin.source);
    return pin;
  }

  revoke(canonicalPath: string): void {
    this.db.prepare('DELETE FROM instruction_file_trust WHERE canonical_path = ?').run(canonicalPath);
  }

  list(): InstructionTrustPin[] {
    const rows = this.db
      .prepare('SELECT canonical_path, sha256, approved_at, source FROM instruction_file_trust ORDER BY canonical_path')
      .all() as Array<{ canonical_path: string; sha256: string; approved_at: number; source: 'user' }>;
    return rows.map((row) => ({
      canonicalPath: row.canonical_path,
      sha256: row.sha256,
      approvedAt: row.approved_at,
      source: row.source,
    }));
  }
}

/**
 * Fail-open accessor for the resolver: any storage error yields `unknown`
 * verdicts in warn-mode semantics (the caller decides what unknown means for
 * its mode; enforce-mode treats storage failure as untrusted = skip, which is
 * the fail-secure direction demanded by the plan).
 */
export function getInstructionTrustEvaluator(): (canonicalPath: string, sha256: string) => InstructionTrustVerdict {
  return (canonicalPath, sha256) => {
    try {
      return InstructionTrustStore.getInstance().evaluate(canonicalPath, sha256);
    } catch {
      return 'unknown';
    }
  };
}
