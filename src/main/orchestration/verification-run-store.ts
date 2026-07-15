import * as crypto from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { VERIFICATION_RUNS_UP_SQL } from '../persistence/rlm/verification-run-schema';
import {
  canonicalizeCommandSegment,
  splitCommandSegments,
} from './loop-canonical-command';

export type VerificationRunScope = 'loop' | 'instance';

export interface VerificationRun {
  id: string;
  scope: VerificationRunScope;
  loopRunId: string | null;
  instanceId: string | null;
  command: string;
  canonicalCommand: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  workHash: string | null;
  outputRef: string | null;
  startedAt: number;
}

export type RecordVerificationRun = Omit<
  VerificationRun,
  'id' | 'canonicalCommand' | 'loopRunId' | 'instanceId' | 'workHash' | 'outputRef'
> & {
  loopRunId?: string;
  instanceId?: string;
  workHash?: string;
  outputRef?: string;
};

interface VerificationRunRow {
  id: string;
  scope: VerificationRunScope;
  loop_run_id: string | null;
  instance_id: string | null;
  command: string;
  canonical_command: string;
  cwd: string;
  exit_code: number | null;
  duration_ms: number;
  work_hash: string | null;
  output_ref: string | null;
  started_at: number;
}

/** Reusable DDL for focused in-memory store tests. */
export function createVerificationRunSchema(db: SqliteDriver): void {
  db.exec(VERIFICATION_RUNS_UP_SQL);
}

/**
 * Converts a shell command to the same wrapper-insensitive representation used
 * by the anti-self-grading matcher. Compound command segments remain ordered.
 */
export function canonicalizeVerificationCommand(command: string): string {
  const segments = splitCommandSegments(command)
    .map(canonicalizeCommandSegment)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.join(' '));
  return segments.join(' && ') || command.trim();
}

/** Durable, queryable ledger of commands AIO itself executed. */
export class VerificationRunStore {
  private static instance: VerificationRunStore | null = null;

  constructor(private readonly db: SqliteDriver) {}

  static getInstance(db: SqliteDriver = getRLMDatabase().getRawDb()): VerificationRunStore {
    if (!VerificationRunStore.instance) {
      VerificationRunStore.instance = new VerificationRunStore(db);
    }
    return VerificationRunStore.instance;
  }

  static _resetForTesting(): void {
    VerificationRunStore.instance = null;
  }

  record(params: RecordVerificationRun): VerificationRun {
    validateRecord(params);
    const run: VerificationRun = {
      id: crypto.randomUUID(),
      scope: params.scope,
      loopRunId: params.scope === 'loop' ? params.loopRunId!.trim() : null,
      instanceId: params.scope === 'instance' ? params.instanceId!.trim() : null,
      command: params.command,
      canonicalCommand: canonicalizeVerificationCommand(params.command),
      cwd: params.cwd,
      exitCode: params.exitCode,
      durationMs: params.durationMs,
      workHash: params.workHash ?? null,
      outputRef: params.outputRef ?? null,
      startedAt: params.startedAt,
    };
    this.db.prepareCached(`
      INSERT INTO verification_runs (
        id, scope, loop_run_id, instance_id, command, canonical_command, cwd,
        exit_code, duration_ms, work_hash, output_ref, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id,
      run.scope,
      run.loopRunId,
      run.instanceId,
      run.command,
      run.canonicalCommand,
      run.cwd,
      run.exitCode,
      run.durationMs,
      run.workHash,
      run.outputRef,
      run.startedAt,
    );
    return run;
  }

  listForLoop(loopRunId: string): VerificationRun[] {
    return this.db.prepareCached(`
      SELECT * FROM verification_runs
      WHERE loop_run_id = ?
      ORDER BY started_at DESC, id DESC
    `).all<VerificationRunRow>(loopRunId).map(toVerificationRun);
  }

  listForInstance(instanceId: string): VerificationRun[] {
    return this.db.prepareCached(`
      SELECT * FROM verification_runs
      WHERE instance_id = ?
      ORDER BY started_at DESC, id DESC
    `).all<VerificationRunRow>(instanceId).map(toVerificationRun);
  }
}

function validateRecord(params: RecordVerificationRun): void {
  if (!params.command.trim()) throw new Error('Verification command is required');
  if (!params.cwd.trim()) throw new Error('Verification cwd is required');
  if (!Number.isFinite(params.durationMs) || params.durationMs < 0) {
    throw new Error('Verification durationMs must be a non-negative finite number');
  }
  if (!Number.isFinite(params.startedAt)) throw new Error('Verification startedAt must be finite');
  if (params.exitCode !== null && !Number.isInteger(params.exitCode)) {
    throw new Error('Verification exitCode must be an integer or null');
  }
  if (params.scope === 'loop') {
    if (!params.loopRunId?.trim() || params.instanceId !== undefined) {
      throw new Error('Loop verification runs require only loopRunId');
    }
    return;
  }
  if (params.scope === 'instance') {
    if (!params.instanceId?.trim() || params.loopRunId !== undefined) {
      throw new Error('Instance verification runs require only instanceId');
    }
    return;
  }
  throw new Error('Verification run scope is invalid');
}

function toVerificationRun(row: VerificationRunRow): VerificationRun {
  return {
    id: row.id,
    scope: row.scope,
    loopRunId: row.loop_run_id,
    instanceId: row.instance_id,
    command: row.command,
    canonicalCommand: row.canonical_command,
    cwd: row.cwd,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    workHash: row.work_hash,
    outputRef: row.output_ref,
    startedAt: row.started_at,
  };
}
