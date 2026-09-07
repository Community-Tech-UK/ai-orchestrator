/**
 * B7 — Stop parks the queue instead of draining it.
 *
 * Hitting Stop mid-turn used to have a surprising consequence: the interrupt
 * drives the session back to `idle`, and both drain triggers — the status
 * transition and the 2-second watchdog — treat `idle` as "go", so the next
 * queued message went out uninvited within a couple of seconds. Someone who
 * deliberately stops a run almost certainly wants to read what happened before
 * the next message fires, not race it.
 *
 * A set of instance ids, not a flag per queued message: parking is a property
 * of the queue as a whole, set by an action taken outside the queue (Stop),
 * and per-item flags would need answering for every message added afterwards.
 *
 * **Parking must be keyed off the user's Stop, not off `interruptInstance`.**
 * The messaging store calls `interruptInstance` itself to deliver a steer, so
 * parking on every interrupt would park the queue that the steer is trying to
 * drain and break steering outright.
 */

import { signal } from '@angular/core';

export interface QueueParkState {
  /** Instances whose queue is held back until the user resumes. */
  parked: ReadonlySet<string>;
}

export function createQueueParkState(): QueueParkState {
  return { parked: new Set<string>() };
}

/**
 * Park after a user-initiated Stop.
 *
 * A no-op when the queue is empty: there is nothing to hold back, and setting
 * the flag would silently strand the next message queued afterwards, which the
 * user never asked to hold.
 */
export function parkQueueOnInterrupt(
  state: QueueParkState,
  instanceId: string,
  queueLength: number,
): QueueParkState {
  if (queueLength <= 0) return state;
  if (state.parked.has(instanceId)) return state;
  const parked = new Set(state.parked);
  parked.add(instanceId);
  return { parked };
}

/** Explicit Resume, and the unpark hook for clearing a queue. */
export function unparkQueue(state: QueueParkState, instanceId: string): QueueParkState {
  if (!state.parked.has(instanceId)) return state;
  const parked = new Set(state.parked);
  parked.delete(instanceId);
  return { parked };
}

export function isQueueParked(state: QueueParkState, instanceId: string): boolean {
  return state.parked.has(instanceId);
}

export interface DrainBlockCheck {
  blocked: boolean;
  /** The state to keep — the flag self-heals here rather than going stale. */
  state: QueueParkState;
}

/**
 * Should a drain be held back — and clean up after itself if not.
 *
 * The self-heal matters because a park flag can outlive its queue. If the user
 * cancels every parked message one at a time, the queue empties without ever
 * going through the clear-queue unpark hook, and the flag survives to strand
 * the next message ever queued for that instance. So an empty queue clears the
 * flag here rather than trusting it.
 *
 * Note the healing trigger is the caller's ordinary drain check, not the
 * 2-second watchdog: the watchdog iterates the queue map's keys, and an empty
 * queue has had its key deleted entirely, so the watchdog never looks at that
 * instance again. The reliable trigger is the drain that runs on every ready
 * transition, queue or no queue.
 */
export function isDrainBlockedByPark(
  state: QueueParkState,
  instanceId: string,
  queueLength: number,
): DrainBlockCheck {
  if (!state.parked.has(instanceId)) return { blocked: false, state };
  if (queueLength <= 0) return { blocked: false, state: unparkQueue(state, instanceId) };
  return { blocked: true, state };
}

export interface QueuePark {
  /** Hold this instance's queue after a user-initiated Stop. */
  park: (instanceId: string, queueLength: number) => void;
  /** Release it — explicit Resume, a cleared queue, or a queue that emptied. */
  unpark: (instanceId: string) => void;
  isParked: (instanceId: string) => boolean;
  /** Should a drain be held back? Also self-heals a flag left on an empty queue. */
  blocksDrain: (instanceId: string, queueLength: number) => boolean;
}

/**
 * The signal lives here rather than in `instance-messaging.store.ts`, which is
 * against its LOC ratchet — the same extraction the branch-episode store needed.
 */
export function createQueuePark(): QueuePark {
  const state = signal(createQueueParkState());
  return {
    park: (instanceId, queueLength) =>
      state.update((current) => parkQueueOnInterrupt(current, instanceId, queueLength)),
    unpark: (instanceId) => state.update((current) => unparkQueue(current, instanceId)),
    isParked: (instanceId) => isQueueParked(state(), instanceId),
    blocksDrain: (instanceId, queueLength) => {
      const check = isDrainBlockedByPark(state(), instanceId, queueLength);
      state.set(check.state);
      return check.blocked;
    },
  };
}
