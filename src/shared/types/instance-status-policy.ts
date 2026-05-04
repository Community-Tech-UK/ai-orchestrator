import type { InstanceStatus } from './instance.types';

const MODEL_SWITCH_ALLOWED_STATUSES = [
  'idle',
  'ready',
  'waiting_for_input',
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
