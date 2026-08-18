export type InstanceStatus =
  | 'initializing'
  | 'ready'
  | 'idle'
  | 'busy'
  | 'processing'
  | 'thinking_deeply'
  | 'waiting_for_input'
  | 'waiting_for_permission'
  | 'interrupting'
  | 'cancelling'
  | 'interrupt-escalating'
  | 'cancelled'
  | 'superseded'
  | 'respawning'
  | 'hibernating'
  | 'hibernated'
  | 'waking'
  | 'degraded'
  | 'error'
  | 'failed'
  | 'terminated';

/**
 * Who asked for a turn to be interrupted.
 *
 * Every caller funnels into `InstanceManager.interruptInstance()`, which until
 * now logged nothing — so a turn that died from an interrupt left no record of
 * which surface requested it, and a stopped turn was indistinguishable in the
 * logs from a provider stall. Threading this through to the single log site in
 * `InterruptRespawnHandler.interrupt()` makes an interrupted turn attributable.
 *
 * `'unknown'` is the default for any caller that has not been updated.
 */
export type InterruptOrigin =
  | 'renderer-ipc'
  | 'mobile-gateway'
  | 'channel-command'
  | 'thin-client'
  | 'steer'
  | 'pause'
  | 'tool-loop-auto'
  | 'unknown';

export type InstanceFailureClass =
  | 'transition'
  | 'startup'
  | 'runtime'
  | 'permission'
  | 'recovery'
  | 'termination';

export interface InstanceCreatedEvent {
  kind: 'created';
  status: InstanceStatus;
  provider?: string;
  parentId: string | null;
  workingDirectory: string;
}

export interface InstanceStatusChangedEvent {
  kind: 'status_changed';
  previousStatus: InstanceStatus;
  status: InstanceStatus;
  failureClass?: InstanceFailureClass;
}

export interface InstanceRemovedEvent {
  kind: 'removed';
  status?: InstanceStatus;
}

export type InstanceEvent =
  | InstanceCreatedEvent
  | InstanceStatusChangedEvent
  | InstanceRemovedEvent;

export interface InstanceEventEnvelope {
  eventId: string;
  seq: number;
  timestamp: number;
  instanceId: string;
  event: InstanceEvent;
}
