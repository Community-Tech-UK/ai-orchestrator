import type { AuxiliaryHelperPause, AuxiliaryLlmSlot } from '../../shared/types/auxiliary-llm.types';

export interface HelperBackoffTransition { kind: 'paused' | 'resumed'; pause: AuxiliaryHelperPause }
interface SlotState { failures: number; delay: number; pausedUntil?: number; startedAt?: number }

/** Per helper type; only a successful call proves an outage has recovered. */
export class AuxiliarySlotBackoff {
  private readonly states = new Map<AuxiliaryLlmSlot, SlotState>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly changed: (pauses: AuxiliaryHelperPause[], transition?: HelperBackoffTransition) => void = () => undefined,
  ) {}
  active(slot: AuxiliaryLlmSlot): AuxiliaryHelperPause | undefined {
    const state = this.states.get(slot);
    return state?.pausedUntil !== undefined && state.pausedUntil > this.now() ? this.pause(slot, state) : undefined;
  }
  recordFailure(slot: AuxiliaryLlmSlot): void {
    const state = this.states.get(slot) ?? { failures: 0, delay: 0 };
    state.failures++;
    this.states.set(slot, state);
    if (state.failures < 2 || (state.pausedUntil ?? 0) > this.now()) return;
    const firstPause = state.startedAt === undefined;
    state.delay = Math.min(300_000, state.delay ? state.delay * 2 : 60_000);
    state.startedAt ??= this.now();
    state.pausedUntil = this.now() + state.delay;
    this.changed(this.snapshot(), firstPause ? { kind: 'paused', pause: this.pause(slot, state) } : undefined);
  }
  recordSuccess(slot: AuxiliaryLlmSlot): void {
    const state = this.states.get(slot);
    if (!state) return;
    this.states.delete(slot);
    this.changed(this.snapshot(), state.startedAt === undefined ? undefined : { kind: 'resumed', pause: this.pause(slot, state) });
  }
  retryNow(slot: AuxiliaryLlmSlot): void {
    const state = this.states.get(slot);
    if (!state) return;
    state.pausedUntil = undefined;
    state.failures = 0;
    this.changed(this.snapshot());
  }
  snapshot(): AuxiliaryHelperPause[] {
    return [...this.states].flatMap(([slot]) => { const pause = this.active(slot); return pause ? [pause] : []; });
  }
  clear(): void { this.states.clear(); this.changed([]); }
  private pause(slot: AuxiliaryLlmSlot, state: SlotState): AuxiliaryHelperPause {
    const pausedUntil = state.pausedUntil ?? this.now();
    const time = new Date(pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    return { slot, pausedUntil, startedAt: state.startedAt ?? this.now(), failures: state.failures,
      reason: `Paused until ${time} after ${state.failures} failures` };
  }
}
