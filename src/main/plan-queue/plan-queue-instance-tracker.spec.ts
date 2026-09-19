import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it } from 'vitest';
import type { InstanceEventEnvelope, InstanceStatus } from '@contracts/types/instance-events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import {
  PlanQueueInstanceTracker,
  type PlanQueueInstanceEventSource,
  type PlanQueueTurnOutcome,
  type TrackedInstanceSnapshot,
} from './plan-queue-instance-tracker';

/**
 * A recorded InstanceManager event stream. The fake only REPLAYS envelopes the
 * test scripts; it never derives an answer from its own state, so a tracker
 * bug cannot be hidden by the fake agreeing with it.
 */
type Recorded =
  | { channel: 'provider'; kind: 'output'; content: string; messageType?: string }
  | { channel: 'provider'; kind: 'complete' }
  | { channel: 'provider'; kind: 'error'; message: string; recoverable?: boolean }
  | { channel: 'provider'; kind: 'exit'; code: number | null; signal: string | null }
  | { channel: 'status'; status: InstanceStatus; previousStatus?: InstanceStatus }
  | { channel: 'removed' };

class ReplaySource extends EventEmitter {
  snapshots = new Map<string, TrackedInstanceSnapshot>();
  private seq = 0;

  getInstance(instanceId: string): TrackedInstanceSnapshot | undefined {
    return this.snapshots.get(instanceId);
  }

  replay(instanceId: string, events: Recorded[]): void {
    for (const event of events) {
      this.seq += 1;
      if (event.channel === 'provider') {
        const { channel: _channel, ...rest } = event;
        const envelope = {
          eventId: `e${this.seq}`,
          seq: this.seq,
          timestamp: this.seq,
          provider: 'claude',
          instanceId,
          event: rest,
        } as unknown as ProviderRuntimeEventEnvelope;
        this.emit('provider:normalized-event', envelope);
      } else if (event.channel === 'status') {
        const envelope: InstanceEventEnvelope = {
          eventId: `e${this.seq}`,
          seq: this.seq,
          timestamp: this.seq,
          instanceId,
          event: { kind: 'status_changed', previousStatus: event.previousStatus ?? 'busy', status: event.status },
        };
        this.emit('instance:event', envelope);
      } else {
        this.emit('instance:removed', instanceId);
      }
    }
  }
}

let source: ReplaySource;
let outcomes: { instanceId: string; outcome: PlanQueueTurnOutcome }[];
let tracker: PlanQueueInstanceTracker;

beforeEach(() => {
  source = new ReplaySource();
  outcomes = [];
  tracker = new PlanQueueInstanceTracker(
    source as unknown as PlanQueueInstanceEventSource,
    (instanceId, outcome) => outcomes.push({ instanceId, outcome }),
  );
  tracker.attach();
  source.snapshots.set('w1', { id: 'w1', status: 'initializing', outputBuffer: [] });
});

const assistant = (content: string): Recorded => ({ channel: 'provider', kind: 'output', messageType: 'assistant', content });

describe('PlanQueueInstanceTracker', () => {
  it('ignores the idle a fresh spawn settles into before any assistant output', () => {
    tracker.track('w1');
    source.replay('w1', [{ channel: 'status', status: 'idle', previousStatus: 'initializing' }]);
    expect(outcomes).toEqual([]);
  });

  it('reports one turn-complete for idle after assistant output, even when complete also fires', () => {
    tracker.track('w1');
    source.replay('w1', [
      { channel: 'status', status: 'busy' },
      assistant('Implemented the plan.'),
      { channel: 'provider', kind: 'complete' },
      { channel: 'status', status: 'idle' },
    ]);
    expect(outcomes).toEqual([
      { instanceId: 'w1', outcome: { kind: 'turn-complete', lastAssistantOutput: 'Implemented the plan.' } },
    ]);
  });

  it('stays quiet after a turn until beginTurn re-arms it, then needs fresh output', () => {
    tracker.track('w1');
    source.replay('w1', [assistant('Round one done.'), { channel: 'status', status: 'idle' }]);
    // James chats with the idle worker: not a queue round.
    source.replay('w1', [{ channel: 'status', status: 'busy' }, assistant('Sure.'), { channel: 'status', status: 'idle' }]);
    expect(outcomes).toHaveLength(1);

    tracker.beginTurn('w1');
    source.replay('w1', [{ channel: 'status', status: 'idle' }]);
    expect(outcomes).toHaveLength(1);
    source.replay('w1', [{ channel: 'status', status: 'busy' }, assistant('Fixed the findings.'), { channel: 'status', status: 'idle' }]);
    expect(outcomes.at(-1)).toEqual({
      instanceId: 'w1',
      outcome: { kind: 'turn-complete', lastAssistantOutput: 'Fixed the findings.' },
    });
  });

  it('classifies a clean turn that ends on a provider limit notice', () => {
    tracker.track('w1');
    source.replay('w1', [
      assistant("You've hit your session limit · resets 6:30pm (Europe/London)"),
      { channel: 'status', status: 'idle' },
    ]);
    expect(outcomes[0].outcome.kind).toBe('provider-limit');
  });

  it('reports waiting_for_input as needs-input and re-arms when James answers in the session', () => {
    tracker.track('w1');
    source.replay('w1', [assistant('Which retention period?'), { channel: 'status', status: 'waiting_for_input' }]);
    expect(outcomes[0]).toEqual({
      instanceId: 'w1',
      outcome: { kind: 'needs-input', status: 'waiting_for_input', lastAssistantOutput: 'Which retention period?' },
    });
    source.replay('w1', [{ channel: 'status', status: 'busy' }, assistant('Done with 30 days.'), { channel: 'status', status: 'idle' }]);
    expect(outcomes[1].outcome).toEqual({ kind: 'turn-complete', lastAssistantOutput: 'Done with 30 days.' });
  });

  it('fails on a non-zero exit mid-turn but not on the exit of an idle, hibernated worker', () => {
    tracker.track('w1');
    source.replay('w1', [assistant('Done.'), { channel: 'status', status: 'idle' }]);
    source.replay('w1', [
      { channel: 'status', status: 'hibernating' },
      { channel: 'provider', kind: 'exit', code: null, signal: 'SIGTERM' },
      { channel: 'status', status: 'hibernated' },
    ]);
    expect(outcomes.map((o) => o.outcome.kind)).toEqual(['turn-complete']);

    tracker.beginTurn('w1');
    source.replay('w1', [{ channel: 'status', status: 'busy' }, { channel: 'provider', kind: 'exit', code: 1, signal: null }]);
    expect(outcomes.at(-1)?.outcome).toEqual({ kind: 'failed', reason: 'instance exited with code 1' });
  });

  it('reports failure statuses and removal even after the turn settled, once', () => {
    tracker.track('w1');
    source.replay('w1', [assistant('Done.'), { channel: 'status', status: 'idle' }, { channel: 'removed' }, { channel: 'removed' }]);
    expect(outcomes.map((o) => o.outcome.kind)).toEqual(['turn-complete', 'failed']);
    expect(tracker.isTracked('w1')).toBe(false);
  });

  it('reconciles a turn that already finished before track() was called', () => {
    source.snapshots.set('w1', {
      id: 'w1',
      status: 'idle',
      outputBuffer: [{ type: 'user', content: 'go' }, { type: 'assistant', content: 'Finished before tracking.' }],
    });
    tracker.track('w1');
    expect(outcomes).toEqual([
      { instanceId: 'w1', outcome: { kind: 'turn-complete', lastAssistantOutput: 'Finished before tracking.' } },
    ]);
  });

  it('ignores untracked instances and recoverable errors', () => {
    source.replay('other', [assistant('x'), { channel: 'status', status: 'idle' }]);
    tracker.track('w1');
    source.replay('w1', [{ channel: 'provider', kind: 'error', message: 'transient', recoverable: true }]);
    expect(outcomes).toEqual([]);
  });
});
