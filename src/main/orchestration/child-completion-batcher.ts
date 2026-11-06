/**
 * Child completion batching (A17 / backlog 17.1, first half).
 *
 * When a parent spawns several children together, each child exit used to wake
 * the parent with its own `child_completed` message. This batcher groups
 * children spawned within `CHILD_BATCH_SPAWN_WINDOW_MS` of each other into one
 * burst and decides per exit whether to deliver at once, hold for the burst's
 * last member, or end the batch with a single synthesis:
 *
 * - `'send-now'` — a failed child, a child outside any burst, or a burst of one
 *   (today's behaviour).
 * - `'hold'` — successful, and another member of the same burst is still
 *   running. The result is kept in memory; the first hold arms one unref'd
 *   `CHILD_BATCH_MAX_HOLD_MS` timer per parent so a hung sibling cannot strand
 *   results forever.
 * - `'final'` — successful, and no other member of its burst is running. The
 *   handler then synthesises every not-yet-reported child. Deliberately does
 *   not consult `remainingChildren`: an older unrelated child must not keep a
 *   finished burst waiting for the timer.
 *
 * `reportedChildIds` (second half of 17.1) also lives here: `takeUnreported`
 * is what keeps a second wave's synthesis listing only its own children.
 *
 * Plain class, owned by `InstanceChildCompletionHandler`; no singleton. Batch
 * state is dropped when the batch completes or its timer fires. If the parent
 * is gone, delivery is suppressed by the admission service exactly as before,
 * and the owner releases state when the parent is removed.
 */

/** Children spawned within this window of their previous sibling share a burst. */
export const CHILD_BATCH_SPAWN_WINDOW_MS = 30_000;

/** Upper bound on how long a successful result waits for its burst-mates. */
export const CHILD_BATCH_MAX_HOLD_MS = 10 * 60_000;

export interface ChildCompletionResultData {
  name: string;
  summary: string;
  success: boolean;
  conclusions: string[];
}

export type ChildBatchDecision = 'send-now' | 'hold' | 'final';

/** Called for every held result released by the maximum-hold timer. */
export type HeldChildReleaseFn = (
  parentId: string,
  childId: string,
  resultData?: ChildCompletionResultData,
) => void;

interface Burst {
  members: Set<string>;
  running: Set<string>;
  lastSpawnAt: number;
}

interface ParentBatchState {
  openBurst: Burst | null;
  bursts: Map<string, Burst>;
  held: Map<string, ChildCompletionResultData | undefined>;
  holdTimer: ReturnType<typeof setTimeout> | null;
  reported: Set<string>;
}

export class ChildCompletionBatcher {
  private readonly parents = new Map<string, ParentBatchState>();
  private disposed = false;

  constructor(private readonly onHeldRelease: HeldChildReleaseFn = () => undefined) {}

  /** Record a spawn so same-turn siblings can be grouped into one burst. */
  noteSpawn(parentId: string, childId: string, now: number = Date.now()): void {
    if (this.disposed) return;
    const state = this.state(parentId);
    const open = state.openBurst;
    if (open && now - open.lastSpawnAt <= CHILD_BATCH_SPAWN_WINDOW_MS) {
      open.members.add(childId);
      open.running.add(childId);
      open.lastSpawnAt = now;
    } else {
      const burst: Burst = {
        members: new Set([childId]),
        running: new Set([childId]),
        lastSpawnAt: now,
      };
      state.openBurst = burst;
      state.bursts.set(childId, burst);
      return;
    }
    state.bursts.set(childId, open);
  }

  /**
   * Decide how one finished child is reported. Call only when the parent still
   * has other running children; the "last child of the set" path synthesises
   * without asking. A failure also releases that burst's held results so they
   * ship alongside the failure instead of waiting for the timer.
   */
  decide(parentId: string, childId: string, options: { success: boolean }): ChildBatchDecision {
    const state = this.parents.get(parentId);
    const burst = state?.bursts.get(childId);
    if (!state || !burst) return 'send-now';

    burst.running.delete(childId);

    if (!options.success) {
      this.releaseHeldInBurst(parentId, state, burst);
      if (burst.running.size === 0) this.dropBurst(state, burst);
      return 'send-now';
    }

    if (burst.members.size <= 1) {
      if (burst.running.size === 0) this.dropBurst(state, burst);
      return 'send-now';
    }

    if (burst.running.size > 0) return 'hold';

    // The batch is done. Its held results are about to be carried by the
    // final synthesis, so drop their held copies and the hold timer.
    this.clearHeldInBurst(state, burst);
    this.dropBurst(state, burst);
    return 'final';
  }

  /** Keep a successful result aside until its batch ends (or the timer fires). */
  hold(parentId: string, childId: string, resultData?: ChildCompletionResultData): void {
    if (this.disposed) return;
    const state = this.state(parentId);
    state.held.set(childId, resultData);
    if (!state.holdTimer) {
      const timer = setTimeout(() => this.releaseAllHeld(parentId), CHILD_BATCH_MAX_HOLD_MS);
      if (typeof timer.unref === 'function') timer.unref();
      state.holdTimer = timer;
    }
  }

  /** Mark one child's result as already reported to the parent. */
  markReported(parentId: string, childId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    state.reported.add(childId);
    if (state.held.delete(childId)) this.clearTimerIfIdle(state);
  }

  /**
   * Split `childIds` into those the parent has not yet been told about, and
   * mark them reported. Also drops any held copies — the caller is about to
   * carry these results in one synthesis.
   */
  takeUnreported(parentId: string, childIds: string[]): string[] {
    if (this.disposed) return [];
    const state = this.state(parentId);
    const fresh = childIds.filter((id) => !state.reported.has(id));
    for (const id of fresh) {
      state.reported.add(id);
      state.held.delete(id);
    }
    this.clearTimerIfIdle(state);
    return fresh;
  }

  /**
   * The parent's whole child set has finished (remaining count reached zero).
   * Drops burst/held/timer state; `reported` is kept so a later wave's
   * synthesis lists only its own children.
   */
  noteParentSettled(parentId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    state.bursts.clear();
    state.openBurst = null;
    state.held.clear();
    this.clearTimerIfIdle(state);
  }

  /** Release a removed parent's history and pending wake-ups. */
  removeParent(parentId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    if (state.holdTimer) clearTimeout(state.holdTimer);
    this.parents.delete(parentId);
  }

  /** Permanently stop pending timers and release history on app shutdown. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.parents.values()) {
      if (state.holdTimer) {
        clearTimeout(state.holdTimer);
        state.holdTimer = null;
      }
      state.held.clear();
      state.bursts.clear();
      state.openBurst = null;
    }
    this.parents.clear();
  }

  private state(parentId: string): ParentBatchState {
    let state = this.parents.get(parentId);
    if (!state) {
      state = {
        openBurst: null,
        bursts: new Map<string, Burst>(),
        held: new Map<string, ChildCompletionResultData | undefined>(),
        holdTimer: null,
        reported: new Set<string>(),
      };
      this.parents.set(parentId, state);
    }
    return state;
  }

  private dropBurst(state: ParentBatchState, burst: Burst): void {
    for (const id of burst.members) {
      if (state.bursts.get(id) === burst) state.bursts.delete(id);
    }
    if (state.openBurst === burst) state.openBurst = null;
  }

  private clearHeldInBurst(state: ParentBatchState, burst: Burst): void {
    for (const id of burst.members) state.held.delete(id);
    this.clearTimerIfIdle(state);
  }

  private releaseHeldInBurst(parentId: string, state: ParentBatchState, burst: Burst): void {
    const released: Array<[string, ChildCompletionResultData | undefined]> = [];
    for (const id of burst.members) {
      if (state.held.has(id)) {
        released.push([id, state.held.get(id)]);
        state.held.delete(id);
      }
    }
    this.clearTimerIfIdle(state);
    for (const [id, resultData] of released) {
      if (this.parents.get(parentId) !== state) break;
      this.onHeldRelease(parentId, id, resultData);
    }
  }

  private releaseAllHeld(parentId: string): void {
    const state = this.parents.get(parentId);
    if (!state) return;
    const released = Array.from(state.held.entries());
    state.held.clear();
    state.bursts.clear();
    state.openBurst = null;
    if (state.holdTimer) {
      clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }
    for (const [id, resultData] of released) {
      if (this.parents.get(parentId) !== state) break;
      this.onHeldRelease(parentId, id, resultData);
    }
  }

  private clearTimerIfIdle(state: ParentBatchState): void {
    if (state.holdTimer && state.held.size === 0) {
      clearTimeout(state.holdTimer);
      state.holdTimer = null;
    }
  }
}
