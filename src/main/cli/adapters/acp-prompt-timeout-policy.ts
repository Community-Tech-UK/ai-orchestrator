import type { AcpToolCallStatus } from '../../../shared/types/cli.types';

/** Long but bounded inactivity lease for provider-reported external work. */
export const DEFAULT_ACTIVE_TOOL_TIMEOUT_MS = 60 * 60_000;

/** Single source of truth: the 60-minute active-tool lease and the turn-wait
 *  diagnosis must never disagree about what "still running" means. */
export function isActiveAcpToolCallStatus(status: AcpToolCallStatus): boolean {
  return status === 'pending' || status === 'in_progress';
}

export function hasActiveAcpToolCall<T extends { status: AcpToolCallStatus }>(
  toolCalls: Iterable<T>,
): boolean {
  for (const toolCall of toolCalls) {
    if (isActiveAcpToolCallStatus(toolCall.status)) return true;
  }
  return false;
}

/**
 * Stall-warning interval for automated child instances. Children run short,
 * tightly-scoped turns, so a 90s silence is already worth surfacing.
 */
export const DEFAULT_CHILD_STALL_WARNING_MS = 90_000;

/**
 * Stall-warning interval for interactive (user-facing) sessions. Half the
 * default `session/prompt` lease, so a silent turn produces a notice before
 * the hard timeout fails it. Without this the watchdog was configured only for
 * Copilot children — every Cursor/Grok session and every top-level chat sat on
 * a spinner with no signal at all, then failed outright ten minutes later.
 */
export const DEFAULT_INTERACTIVE_STALL_WARNING_MS = 5 * 60_000;

export function resolveAcpStallWarningMs(isChild: boolean): number {
  return isChild ? DEFAULT_CHILD_STALL_WARNING_MS : DEFAULT_INTERACTIVE_STALL_WARNING_MS;
}

/**
 * Titles are free-form agent-supplied text — a `tool_call` title is routinely a
 * whole shell command line. Bound it before it reaches an error message or a
 * log field.
 */
const MAX_SUBJECT_CHARS = 120;

function truncateSubject(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SUBJECT_CHARS
    ? `${collapsed.slice(0, MAX_SUBJECT_CHARS - 1)}…`
    : collapsed;
}

/** Who, if anyone, owns the silence on an ACP prompt turn. */
export type AcpTurnWaitKind = 'permission' | 'tool' | 'unowned';

export interface AcpTurnWait {
  kind: AcpTurnWaitKind;
  /** Truncated agent-supplied label. Absent when `kind` is `unowned`. */
  subject?: string;
  /** Tool status when `kind` is `tool`. */
  status?: AcpToolCallStatus;
}

/** Minimal view of an outstanding permission request the classifier needs. */
export interface AcpPromptTimeoutPermission {
  title: string;
}

/**
 * Keep only the permission requests belonging to the live turn.
 *
 * `pendingPermissionRequests` has no turn-boundary clear, and a failed
 * `sendResponse` write leaves an entry behind, so without this a dead turn's
 * request would be reported as the cause of a later turn's silence — the same
 * confident-wrong diagnosis this module exists to remove. A turn start of 0
 * (no turn in flight) keeps everything: there is no turn to attribute to, and
 * silently dropping every candidate would be its own wrong answer.
 */
export function selectCurrentTurnPermissions<T extends { createdAt: number }>(
  requests: Iterable<T>,
  turnStartedAt: number | null,
): T[] {
  const since = turnStartedAt ?? 0;
  return [...requests].filter((request) => request.createdAt >= since);
}

export interface AcpPromptTimeoutObservation<T extends { title: string; status: AcpToolCallStatus }> {
  toolCalls: Iterable<T>;
  /** Permission requests belonging to the CURRENT turn only — a leaked entry
   *  from an earlier turn would misattribute this one's silence. */
  permissions: Iterable<AcpPromptTimeoutPermission>;
}

/**
 * Work out what the turn was waiting on. Both the stall watchdog and the
 * `session/prompt` timeout report from this, so a warning and the failure that
 * may follow it never disagree about the cause.
 */
export function classifyAcpTurnWait<T extends { title: string; status: AcpToolCallStatus }>(
  observation: AcpPromptTimeoutObservation<T>,
): AcpTurnWait {
  const permission = [...observation.permissions][0];
  if (permission) {
    return { kind: 'permission', subject: truncateSubject(permission.title) };
  }

  const activeToolCall = [...observation.toolCalls]
    .find((toolCall) => isActiveAcpToolCallStatus(toolCall.status));
  if (activeToolCall) {
    return {
      kind: 'tool',
      subject: truncateSubject(activeToolCall.title),
      status: activeToolCall.status,
    };
  }

  return { kind: 'unowned' };
}

/**
 * Explain a `session/prompt` timeout from what the adapter actually observed
 * rather than from a guess. The old text always claimed the agent "may be
 * stuck on an orphaned tool call or permission request" — in the incident this
 * was written for, both had completed and the agent simply stopped emitting
 * updates, so the message sent the next reader down the wrong path.
 *
 * The trailing advice has to match what the runtime then does: an ACP prompt
 * timeout is classified recoverable (`isRecoverableAcpPromptTurnError`), the
 * instance is kept alive and returned to `idle`, so the user can just send
 * again. Telling them to restart would contradict that.
 */
export function describeAcpPromptTimeoutCause(wait: AcpTurnWait): string {
  switch (wait.kind) {
    case 'permission':
      return `A permission request (${wait.subject}) was still unanswered, so the agent was blocked on it.`;
    case 'tool':
      return `Tool call ${wait.subject} was still ${wait.status} and never reported a result.`;
    default:
      return 'No tool call or permission request was outstanding, so the agent stopped responding on its own. '
        + 'The session stays open — send again to retry.';
  }
}

/**
 * Narrate an in-flight silence. Deliberately not one message: telling a user
 * their turn "may be stuck, cancel it" while a legitimate 20-minute build runs
 * teaches them to ignore the notice that matters. Naming the thing being
 * waited on keeps the signal without the false alarm — and, unlike suppressing
 * the warning outright, it still surfaces an agent that died holding a
 * `pending` tool call, which would otherwise stay silent until the 60-minute
 * `activeToolTimeoutMs` lease expires.
 */
export function describeAcpStallWarning(wait: AcpTurnWait, inactiveMs: number): string {
  const seconds = Math.round(inactiveMs / 1000);
  switch (wait.kind) {
    case 'permission':
      return `Waiting ${seconds}s for a response to the permission request (${wait.subject}).`;
    case 'tool':
      return `Tool call ${wait.subject} has been ${wait.status} for ${seconds}s with no update.`;
    default:
      return `This turn hasn't produced any output for ${seconds}s — it may be stuck. `
        + 'Cancel the turn to try again.';
  }
}
