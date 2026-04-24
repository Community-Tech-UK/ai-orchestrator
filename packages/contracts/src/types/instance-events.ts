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

export type InstanceEventKind = 'created' | 'status_changed' | 'removed';

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
