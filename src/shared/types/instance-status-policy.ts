import type { InstanceStatus } from './instance.types';

/**
 * Statuses from which a runtime (provider/model/yolo) change may be applied.
 *
 * The gate exists to keep a respawn from tearing down a live turn — not to
 * protect a session that is already dead. `error` is a settled status (it is in
 * `INSTANCE_SETTLED_STATUSES`, `error → initializing` is a legal transition, and
 * no turn is in flight), and switching provider is precisely how a user escapes
 * a provider that is 503ing. Excluding it meant a swap requested from `error`
 * could only ever queue, and the sole thing that clears `error` is a successful
 * restart of the failing provider — so the queued swap never applied.
 */
const MODEL_SWITCH_ALLOWED_STATUSES = [
  'idle',
  'ready',
  'waiting_for_input',
  'error',
] as const satisfies readonly InstanceStatus[];

type ModelSwitchAllowedStatus = typeof MODEL_SWITCH_ALLOWED_STATUSES[number];

export function isModelSwitchAllowedStatus(
  status: InstanceStatus | undefined,
): status is ModelSwitchAllowedStatus {
  return (
    status !== undefined &&
    (MODEL_SWITCH_ALLOWED_STATUSES as readonly string[]).includes(status)
  );
}

export function getModelSwitchUnavailableReason(
  status: InstanceStatus | undefined,
): string | undefined {
  if (isModelSwitchAllowedStatus(status)) {
    return undefined;
  }

  if (!status) {
    return 'Model changes require a selected live session.';
  }

  return `Model changes are only available while the instance is waiting for user input. Current status: ${status}.`;
}

/**
 * Instance statuses the automation runner treats as a failed run.
 *
 * Defined here rather than in the runner because the project rail needs exactly
 * the same set: a hidden automation is revealed precisely when its run failed.
 * If the two lists were maintained separately, a status added to one and not the
 * other would leave a broken hidden automation silently missing from the rail —
 * the one failure mode hiding must never introduce.
 */
export const AUTOMATION_FAILURE_STATUSES = new Set<InstanceStatus>([
  'error',
  'failed',
  'terminated',
  'cancelled',
  'superseded',
]);

/**
 * Statuses where a run has parked awaiting a human. The runner terminalizes
 * these as non-retryable failures, and the rail must surface them for the same
 * reason: an unattended automation waiting forever on a permission prompt is
 * exactly what a hidden session would otherwise conceal.
 */
export const AUTOMATION_WAIT_STATUSES = new Set<InstanceStatus>([
  'waiting_for_input',
  'waiting_for_permission',
]);

/**
 * True when an automation-born session needs the operator's eyes — it failed, or
 * it is parked waiting for a human. Hidden automations are shown in the project
 * rail in exactly these states.
 */
export function isAutomationAttentionStatus(status: InstanceStatus | undefined): boolean {
  return status !== undefined
    && (AUTOMATION_FAILURE_STATUSES.has(status) || AUTOMATION_WAIT_STATUSES.has(status));
}
