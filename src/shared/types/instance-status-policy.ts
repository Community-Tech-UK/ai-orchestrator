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
