import type { ChatRecord } from '../../../../shared/types/chat.types';
import type { InstanceStatus } from '../../../../shared/types/instance.types';

export type ChatRuntimeStateKind =
  | 'setup'
  | 'dormant'
  | 'stale'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'waiting'
  | 'error';

export interface ChatRuntimeState {
  kind: ChatRuntimeStateKind;
  label: string;
  statusClass: string;
  description: string;
}

const BUSY_STATUSES = new Set<InstanceStatus>([
  'busy',
  'processing',
  'thinking_deeply',
]);

const STARTING_STATUSES = new Set<InstanceStatus>([
  'initializing',
  'waking',
  'respawning',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
]);

const WAITING_STATUSES = new Set<InstanceStatus>([
  'waiting_for_input',
  'waiting_for_permission',
]);

export function deriveChatRuntimeState(
  chat: ChatRecord,
  instanceStatus: InstanceStatus | undefined,
): ChatRuntimeState {
  if (!chat.provider || !chat.currentCwd) {
    return {
      kind: 'setup',
      label: 'Setup',
      statusClass: 'runtime-setup',
      description: 'Provider and project must be selected before this chat can run.',
    };
  }

  if (!chat.currentInstanceId) {
    return {
      kind: 'dormant',
      label: 'Dormant',
      statusClass: 'runtime-dormant',
      description: 'This chat is persisted and will spawn a runtime on the next message.',
    };
  }

  if (!instanceStatus) {
    return {
      kind: 'stale',
      label: 'Reconnect',
      statusClass: 'runtime-stale',
      description: 'The saved runtime link is stale; the next message will reconnect this chat.',
    };
  }

  if (BUSY_STATUSES.has(instanceStatus)) {
    return {
      kind: 'busy',
      label: 'Busy',
      statusClass: 'runtime-busy',
      description: `Runtime is ${instanceStatus}.`,
    };
  }

  if (STARTING_STATUSES.has(instanceStatus)) {
    return {
      kind: 'starting',
      label: 'Starting',
      statusClass: 'runtime-starting',
      description: `Runtime is ${instanceStatus}.`,
    };
  }

  if (WAITING_STATUSES.has(instanceStatus)) {
    return {
      kind: 'waiting',
      label: 'Waiting',
      statusClass: 'runtime-waiting',
      description: `Runtime is ${instanceStatus}.`,
    };
  }

  if (instanceStatus === 'error') {
    return {
      kind: 'error',
      label: 'Error',
      statusClass: 'runtime-error',
      description: 'Runtime is in an error state.',
    };
  }

  return {
    kind: 'ready',
    label: instanceStatus === 'idle' ? 'Idle' : 'Ready',
    statusClass: 'runtime-ready',
    description: `Runtime is ${instanceStatus}.`,
  };
}
