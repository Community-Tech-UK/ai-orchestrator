import type { LocalAiRepairAction } from '../../shared/types/local-ai-guard.types';
import { LocalAiRepairActionSchema } from '../../shared/validation/local-ai-guard.schemas';
import type { SqliteDriver } from '../db/sqlite-driver';

export type LocalAiRecoveryAttemptOutcome =
  | 'claimed'
  | 'unsupported'
  | 'failed'
  | 'not-recovered'
  | 'recovered';

export interface LocalAiRecoveryAttempt {
  id: string;
  targetId: string;
  action: LocalAiRepairAction;
  attemptNumber: number;
  claimedAt: number;
  completedAt?: number;
  outcome: LocalAiRecoveryAttemptOutcome;
  supported?: boolean;
  attempted?: boolean;
  recovered?: boolean;
}

export type LocalAiRecoveryAttemptClaim =
  | { claimed: true; attempt: LocalAiRecoveryAttempt }
  | {
      claimed: false;
      reason: 'max-attempts' | 'cooldown';
      attemptCount: number;
      nextEligibleAt?: number;
    };

export interface LocalAiRecoveryAttemptClaimInput {
  id: string;
  targetId: string;
  action: LocalAiRepairAction;
  claimedAt: number;
  maxAttempts: number;
  cooldownMs: number;
}

export interface LocalAiRecoveryAttemptCompletion {
  completedAt: number;
  outcome: Exclude<LocalAiRecoveryAttemptOutcome, 'claimed'>;
  supported: boolean;
  attempted: boolean;
  recovered: boolean;
}

interface LocalAiRecoveryAttemptRow {
  id: string;
  target_id: string;
  action: string;
  attempt_number: number;
  claimed_at: number;
  completed_at: number | null;
  outcome: string;
  supported: number | null;
  attempted: number | null;
  recovered: number | null;
}

interface LocalAiRecoveryAttemptSummaryRow {
  attempt_count: number;
  last_claimed_at: number | null;
}

const MAX_LISTED_RECOVERY_ATTEMPTS = 1_000;
const COMPLETION_OUTCOMES = new Set<LocalAiRecoveryAttemptCompletion['outcome']>([
  'unsupported',
  'failed',
  'not-recovered',
  'recovered',
]);

export function claimLocalAiRecoveryAttempt(
  db: SqliteDriver,
  raw: LocalAiRecoveryAttemptClaimInput,
): LocalAiRecoveryAttemptClaim {
  const input = validateClaimInput(raw);
  const cooldownCutoff = input.claimedAt - input.cooldownMs;
  const row = db.prepareCached(`
    INSERT INTO local_ai_recovery_attempts (
      id, target_id, action, attempt_number, claimed_at, outcome
    )
    SELECT ?, ?, ?,
      COALESCE((
        SELECT MAX(attempt_number) FROM local_ai_recovery_attempts WHERE target_id = ?
      ), 0) + 1,
      ?, 'claimed'
    WHERE ? > 0
      AND (
        SELECT COUNT(*) FROM local_ai_recovery_attempts WHERE target_id = ?
      ) < ?
      AND (
        ? = 0 OR NOT EXISTS (
          SELECT 1 FROM local_ai_recovery_attempts
          WHERE target_id = ? AND claimed_at > ?
        )
      )
    RETURNING *
  `).get<LocalAiRecoveryAttemptRow>(
    input.id,
    input.targetId,
    input.action,
    input.targetId,
    input.claimedAt,
    input.maxAttempts,
    input.targetId,
    input.maxAttempts,
    input.cooldownMs,
    input.targetId,
    cooldownCutoff,
  );
  if (row) return { claimed: true, attempt: mapRecoveryAttempt(row) };

  const summary = db.prepareCached(`
    SELECT COUNT(*) AS attempt_count, MAX(claimed_at) AS last_claimed_at
    FROM local_ai_recovery_attempts WHERE target_id = ?
  `).get<LocalAiRecoveryAttemptSummaryRow>(input.targetId) ?? {
    attempt_count: 0,
    last_claimed_at: null,
  };
  if (summary.attempt_count >= input.maxAttempts) {
    return {
      claimed: false,
      reason: 'max-attempts',
      attemptCount: summary.attempt_count,
    };
  }
  const lastClaimedAt = summary.last_claimed_at ?? input.claimedAt;
  return {
    claimed: false,
    reason: 'cooldown',
    attemptCount: summary.attempt_count,
    nextEligibleAt: addTimestamp(lastClaimedAt, input.cooldownMs),
  };
}

export function completeLocalAiRecoveryAttempt(
  db: SqliteDriver,
  attemptId: string,
  raw: LocalAiRecoveryAttemptCompletion,
): boolean {
  const completion = validateCompletion(raw);
  const result = db.prepareCached(`
    UPDATE local_ai_recovery_attempts SET
      completed_at = ?, outcome = ?, supported = ?, attempted = ?, recovered = ?
    WHERE id = ? AND outcome = 'claimed' AND claimed_at <= ?
  `).run(
    completion.completedAt,
    completion.outcome,
    completion.supported ? 1 : 0,
    completion.attempted ? 1 : 0,
    completion.recovered ? 1 : 0,
    requireId(attemptId, 'attempt ID'),
    completion.completedAt,
  );
  return result.changes === 1;
}

export function listLocalAiRecoveryAttempts(
  db: SqliteDriver,
  targetId: string,
): LocalAiRecoveryAttempt[] {
  return db.prepareCached(`
    SELECT * FROM local_ai_recovery_attempts
    WHERE target_id = ? ORDER BY attempt_number ASC, id ASC LIMIT ?
  `).all<LocalAiRecoveryAttemptRow>(
    requireId(targetId, 'target ID'),
    MAX_LISTED_RECOVERY_ATTEMPTS,
  ).map(mapRecoveryAttempt);
}

function validateClaimInput(
  input: LocalAiRecoveryAttemptClaimInput,
): LocalAiRecoveryAttemptClaimInput {
  return {
    id: requireId(input.id, 'attempt ID'),
    targetId: requireId(input.targetId, 'target ID'),
    action: LocalAiRepairActionSchema.parse(input.action),
    claimedAt: requireNonnegativeInteger(input.claimedAt, 'claimedAt'),
    maxAttempts: requireNonnegativeInteger(input.maxAttempts, 'maxAttempts'),
    cooldownMs: requireNonnegativeInteger(input.cooldownMs, 'cooldownMs'),
  };
}

function validateCompletion(
  input: LocalAiRecoveryAttemptCompletion,
): LocalAiRecoveryAttemptCompletion {
  if (!COMPLETION_OUTCOMES.has(input.outcome)) {
    throw new Error('Invalid Local AI recovery attempt outcome');
  }
  const supported = requireBoolean(input.supported, 'supported');
  const attempted = requireBoolean(input.attempted, 'attempted');
  const recovered = requireBoolean(input.recovered, 'recovered');
  const coherentRecovery =
    (input.outcome === 'unsupported' && !supported && !attempted && !recovered)
    || (input.outcome === 'failed' && supported && !recovered)
    || (input.outcome === 'not-recovered' && supported && attempted && !recovered)
    || (input.outcome === 'recovered' && supported && attempted && recovered);
  if (!coherentRecovery) {
    throw new Error('Invalid Local AI recovery attempt outcome');
  }
  return {
    completedAt: requireNonnegativeInteger(input.completedAt, 'completedAt'),
    outcome: input.outcome,
    supported,
    attempted,
    recovered,
  };
}

function mapRecoveryAttempt(row: LocalAiRecoveryAttemptRow): LocalAiRecoveryAttempt {
  return {
    id: requireId(row.id, 'attempt ID'),
    targetId: requireId(row.target_id, 'target ID'),
    action: LocalAiRepairActionSchema.parse(row.action),
    attemptNumber: requireNonnegativeInteger(row.attempt_number, 'attemptNumber'),
    claimedAt: requireNonnegativeInteger(row.claimed_at, 'claimedAt'),
    ...(row.completed_at === null ? {} : {
      completedAt: requireNonnegativeInteger(row.completed_at, 'completedAt'),
    }),
    outcome: parseOutcome(row.outcome),
    ...(row.supported === null ? {} : { supported: sqliteBoolean(row.supported) }),
    ...(row.attempted === null ? {} : { attempted: sqliteBoolean(row.attempted) }),
    ...(row.recovered === null ? {} : { recovered: sqliteBoolean(row.recovered) }),
  };
}

function parseOutcome(value: string): LocalAiRecoveryAttemptOutcome {
  if (value === 'claimed' || COMPLETION_OUTCOMES.has(value as LocalAiRecoveryAttemptCompletion['outcome'])) {
    return value as LocalAiRecoveryAttemptOutcome;
  }
  throw new Error('Invalid persisted Local AI recovery attempt outcome');
}

function requireId(value: string, name: string): string {
  const parsed = value.trim();
  if (!parsed || parsed.length > 256) throw new Error(`Invalid Local AI recovery ${name}`);
  return parsed;
}

function requireNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Local AI recovery ${name} must be a non-negative safe integer`);
  }
  return value;
}

function requireBoolean(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Local AI recovery ${name} must be boolean`);
  return value;
}

function sqliteBoolean(value: number): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new Error(`Invalid persisted Local AI recovery boolean: ${value}`);
}

function addTimestamp(timestamp: number, durationMs: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, timestamp + durationMs);
}
