/**
 * Plan Queue instance tracking — turns InstanceManager events into one
 * outcome per turn for each queue-owned instance.
 *
 * The rules follow AutomationRunner (automation-runner.ts `handleProviderEvent`,
 * `handleInstanceEvent`, `reconcileInstanceState`, `completeTrackedInstance`):
 *  - a turn is complete at `idle` (or provider `complete`) AFTER assistant output
 *    was seen — an idle before any output is the spawn settling, not a turn;
 *  - `waiting_for_input` / `waiting_for_permission` need a human;
 *  - failure statuses and removal are failures, and so are a non-recoverable
 *    provider error or a non-zero exit during a turn;
 *  - a clean turn whose final assistant output is a provider-limit notice is a
 *    provider limit, not a completed turn.
 *
 * Unlike an automation run, a queue worker lives for many turns. After an
 * outcome the tracker goes quiet until the coordinator re-arms it with
 * `beginTurn` just before it sends the next input. A worker that stopped for
 * input re-arms itself when it starts working again (James answered it in its
 * own session).
 */

import type { InstanceEventEnvelope, InstanceStatus } from '@contracts/types/instance-events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import {
  AUTOMATION_FAILURE_STATUSES,
  AUTOMATION_WAIT_STATUSES,
} from '../../shared/types/instance-status-policy';
import { classifyFinalOutputProviderLimit } from '../cli/final-output-provider-limit';

export type PlanQueueTurnOutcome =
  | { kind: 'turn-complete'; lastAssistantOutput: string | null }
  | { kind: 'provider-limit'; notice: string }
  | { kind: 'needs-input'; status: InstanceStatus; lastAssistantOutput: string | null }
  | { kind: 'failed'; reason: string };

/** The slice of InstanceManager the tracker reads. */
export interface PlanQueueInstanceEventSource {
  on(event: 'provider:normalized-event', listener: (envelope: ProviderRuntimeEventEnvelope) => void): unknown;
  on(event: 'instance:event', listener: (envelope: InstanceEventEnvelope) => void): unknown;
  on(event: 'instance:removed', listener: (instanceId: string) => void): unknown;
  getInstance(instanceId: string): TrackedInstanceSnapshot | undefined;
}

export interface TrackedInstanceSnapshot {
  id: string;
  status: InstanceStatus;
  outputBuffer: readonly { type: string; content: string }[];
}

interface Tracking {
  seenAssistantOutput: boolean;
  lastAssistantOutput: string | null;
  /** True after an outcome was reported for the current turn. */
  settled: boolean;
  /** The outcome that settled it, so a resumed wait can re-arm. */
  settledBy: PlanQueueTurnOutcome['kind'] | null;
}

const WORKING_STATUSES = new Set<InstanceStatus>(['busy', 'processing', 'thinking_deeply']);

export class PlanQueueInstanceTracker {
  private readonly tracking = new Map<string, Tracking>();
  private attached = false;

  constructor(
    private readonly source: PlanQueueInstanceEventSource,
    private readonly onOutcome: (instanceId: string, outcome: PlanQueueTurnOutcome) => void,
  ) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.source.on('provider:normalized-event', (envelope) => this.handleProviderEvent(envelope));
    this.source.on('instance:event', (envelope) => this.handleInstanceEvent(envelope));
    this.source.on('instance:removed', (instanceId) => this.fail(instanceId, 'instance was removed'));
  }

  isTracked(instanceId: string): boolean {
    return this.tracking.has(instanceId);
  }

  /**
   * Start watching an instance whose turn is already running (a fresh spawn
   * with an initial prompt, or an instance re-attached after a restart), and
   * reconcile against its current state so an event that fired before this
   * call is not missed.
   */
  track(instanceId: string): void {
    this.tracking.set(instanceId, emptyTracking());
    this.reconcile(instanceId);
  }

  /** Re-arm for the next turn. Call BEFORE sending the input that starts it. */
  beginTurn(instanceId: string): void {
    this.tracking.set(instanceId, emptyTracking());
  }

  untrack(instanceId: string): void {
    this.tracking.delete(instanceId);
  }

  private reconcile(instanceId: string): void {
    const instance = this.source.getInstance(instanceId);
    const tracking = this.tracking.get(instanceId);
    if (!tracking) return;
    if (!instance) {
      this.fail(instanceId, 'instance no longer exists');
      return;
    }
    const assistant = [...instance.outputBuffer]
      .reverse()
      .find((message) => message.type === 'assistant' && message.content.trim().length > 0);
    if (assistant) {
      tracking.seenAssistantOutput = true;
      tracking.lastAssistantOutput = assistant.content;
    }
    this.applyStatus(instanceId, instance.status);
  }

  private handleProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    const tracking = this.tracking.get(envelope.instanceId);
    if (!tracking) return;
    const event = envelope.event;
    switch (event.kind) {
      case 'output':
        if (event.messageType === 'assistant' && event.content.trim().length > 0) {
          tracking.seenAssistantOutput = true;
          tracking.lastAssistantOutput = event.content;
        }
        break;
      case 'complete':
        if (tracking.seenAssistantOutput && !tracking.settled) this.completeTurn(envelope.instanceId);
        break;
      // Process-level errors and exits count only mid-turn. An idle worker
      // waiting for its verifier is hibernated by killing its CLI, and that
      // exit is not a failure; a status-level failure below still is.
      case 'error':
        if (!event.recoverable && !tracking.settled) this.fail(envelope.instanceId, event.message);
        break;
      case 'exit':
        if (event.code !== 0 && !tracking.settled) {
          this.fail(
            envelope.instanceId,
            `instance exited with ${event.signal ? `signal ${event.signal}` : `code ${event.code ?? 'unknown'}`}`,
          );
        }
        break;
      default:
        break;
    }
  }

  private handleInstanceEvent(envelope: InstanceEventEnvelope): void {
    if (!this.tracking.has(envelope.instanceId)) return;
    const event = envelope.event;
    if (event.kind === 'removed') {
      this.fail(envelope.instanceId, 'instance was removed');
    } else if (event.kind === 'status_changed') {
      this.applyStatus(envelope.instanceId, event.status);
    }
  }

  private applyStatus(instanceId: string, status: InstanceStatus): void {
    const tracking = this.tracking.get(instanceId);
    if (!tracking) return;
    if (AUTOMATION_FAILURE_STATUSES.has(status)) {
      this.fail(instanceId, `instance entered ${status}`);
      return;
    }
    if (WORKING_STATUSES.has(status) && tracking.settledBy === 'needs-input') {
      // James answered the worker directly; watch the turn that answer started.
      this.tracking.set(instanceId, emptyTracking());
      return;
    }
    if (tracking.settled) return;
    if (AUTOMATION_WAIT_STATUSES.has(status)) {
      this.settle(instanceId, tracking, {
        kind: 'needs-input',
        status,
        lastAssistantOutput: tracking.lastAssistantOutput,
      });
      return;
    }
    if (status === 'idle' && tracking.seenAssistantOutput) {
      this.completeTurn(instanceId);
    }
  }

  private completeTurn(instanceId: string): void {
    const tracking = this.tracking.get(instanceId);
    if (!tracking || tracking.settled) return;
    const limit = classifyFinalOutputProviderLimit(tracking.lastAssistantOutput ?? undefined);
    this.settle(
      instanceId,
      tracking,
      limit
        ? { kind: 'provider-limit', notice: limit }
        : { kind: 'turn-complete', lastAssistantOutput: tracking.lastAssistantOutput },
    );
  }

  /** A failure is reported even for a settled turn: the instance is gone either way. */
  private fail(instanceId: string, reason: string): void {
    if (!this.tracking.has(instanceId)) return;
    this.tracking.delete(instanceId);
    this.onOutcome(instanceId, { kind: 'failed', reason });
  }

  private settle(instanceId: string, tracking: Tracking, outcome: PlanQueueTurnOutcome): void {
    tracking.settled = true;
    tracking.settledBy = outcome.kind;
    this.onOutcome(instanceId, outcome);
  }
}

function emptyTracking(): Tracking {
  return { seenAssistantOutput: false, lastAssistantOutput: null, settled: false, settledBy: null };
}
