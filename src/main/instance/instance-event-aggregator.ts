import { randomUUID } from 'node:crypto';
import type {
  InstanceEventEnvelope,
  InstanceFailureClass,
  InstanceStatus,
} from '@contracts/types/instance-events';
import type { Instance } from '../../shared/types/instance.types';

interface InstanceStateUpdateLike {
  instanceId: string;
  status: Instance['status'];
  previousStatus: Instance['status'];
  timestamp: number;
}

export class InstanceEventAggregator {
  private seqByInstance = new Map<string, number>();
  private statusByInstance = new Map<string, InstanceStatus>();

  recordCreated(instance: Pick<Instance, 'id' | 'status' | 'provider' | 'parentId' | 'workingDirectory'>): InstanceEventEnvelope {
    this.statusByInstance.set(instance.id, instance.status as InstanceStatus);
    return this.makeEnvelope(instance.id, {
      kind: 'created',
      status: instance.status as InstanceStatus,
      provider: instance.provider,
      parentId: instance.parentId,
      workingDirectory: instance.workingDirectory,
    });
  }

  recordStateUpdate(payload: InstanceStateUpdateLike): InstanceEventEnvelope {
    this.statusByInstance.set(payload.instanceId, payload.status as InstanceStatus);

    const failureClass = this.classifyFailure(payload);
    return this.makeEnvelope(
      payload.instanceId,
      {
        kind: 'status_changed',
        previousStatus: payload.previousStatus as InstanceStatus,
        status: payload.status as InstanceStatus,
        ...(failureClass ? { failureClass } : {}),
      },
      payload.timestamp,
    );
  }

  recordRemoved(instanceId: string, status?: Instance['status']): InstanceEventEnvelope {
    const resolvedStatus = (status ?? this.statusByInstance.get(instanceId)) as InstanceStatus | undefined;
    const envelope = this.makeEnvelope(instanceId, {
      kind: 'removed',
      ...(resolvedStatus ? { status: resolvedStatus } : {}),
    });

    this.seqByInstance.delete(instanceId);
    this.statusByInstance.delete(instanceId);
    return envelope;
  }

  private classifyFailure(payload: InstanceStateUpdateLike): InstanceFailureClass | undefined {
    if (payload.status === 'error') {
      return 'runtime';
    }

    if (payload.status === 'failed') {
      if (payload.previousStatus === 'initializing') {
        return 'startup';
      }
      if (payload.previousStatus === 'respawning') {
        return 'recovery';
      }
      return 'runtime';
    }

    if (payload.status === 'terminated' && payload.previousStatus !== 'terminated') {
      return 'termination';
    }

    return undefined;
  }

  private makeEnvelope(
    instanceId: string,
    event: InstanceEventEnvelope['event'],
    timestamp = Date.now(),
  ): InstanceEventEnvelope {
    return {
      eventId: randomUUID(),
      seq: this.nextSeq(instanceId),
      timestamp,
      instanceId,
      event,
    };
  }

  private nextSeq(instanceId: string): number {
    const next = this.seqByInstance.get(instanceId) ?? 0;
    this.seqByInstance.set(instanceId, next + 1);
    return next;
  }
}
