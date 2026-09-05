/**
 * N9 — aggregate pending approvals into one honest statement.
 *
 * A pending approval shows as a per-row chip. That works when someone is
 * looking at the list; it means nothing overnight, when the actual failure mode
 * is several sessions sitting blocked for hours and no one knowing. The only
 * approval notification today is for the adjudicator's denial breaker tripping
 * (`approval-adjudicator.ts`), which is a different and rarer event.
 *
 * One notification for all of them, not one per approval: five blocked sessions
 * should be one line saying five, not five lines.
 */

export interface PendingApprovalLike {
  approvalId: string;
  instanceId: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingApprovalDigest {
  /** Distinct instances blocked. */
  instances: number;
  /** Total pending approvals. */
  approvals: number;
  /** Age of the oldest, in ms. */
  oldestAgeMs: number;
  title: string;
  body: string;
}

export interface DigestInput {
  pending: readonly PendingApprovalLike[];
  now: number;
  /** Only speak up once something has actually been waiting. */
  minAgeMs: number;
}

function humanAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/**
 * Build a digest, or `null` when there is nothing worth saying.
 *
 * Expired approvals are excluded: they are no longer waiting on a human, and
 * counting them would inflate the number the operator is asked to act on —
 * the same "confident wrong number" problem that makes a dashboard useless.
 */
export function pendingApprovalDigest(input: DigestInput): PendingApprovalDigest | null {
  const live = input.pending.filter(
    (a) => a.expiresAt > input.now && input.now - a.createdAt >= input.minAgeMs,
  );
  if (live.length === 0) return null;

  const instances = new Set(live.map((a) => a.instanceId)).size;
  const oldestAgeMs = Math.max(...live.map((a) => input.now - a.createdAt));
  const sessionWord = instances === 1 ? 'session is' : 'sessions are';
  const approvalWord = live.length === 1 ? 'approval' : 'approvals';

  return {
    instances,
    approvals: live.length,
    oldestAgeMs,
    title: 'Sessions are waiting for approval',
    body: `${instances} ${sessionWord} blocked on ${live.length} ${approvalWord}. `
      + `The oldest has been waiting ${humanAge(oldestAgeMs)}.`,
  };
}
