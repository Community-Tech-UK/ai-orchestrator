import { EventEmitter } from 'events';
import {
  PausePersistence,
  type PauseReason,
  type PauseTransition,
} from './pause-persistence';
import type { PauseStatePayload } from '@contracts/schemas/pause';

export type { PauseReason };

export interface PauseState {
  isPaused: boolean;
  reasons: Set<PauseReason>;
  pausedAt: number | null;
  lastChange: number;
}

export type PauseCoordinatorEvent = 'pause' | 'resume' | 'change';

const STALE_PERSISTED_MS = 24 * 60 * 60 * 1000;

export class PauseCoordinator extends EventEmitter {
  private static instance: PauseCoordinator | null = null;

  private state: PauseState = {
    isPaused: false,
    reasons: new Set<PauseReason>(),
    pausedAt: null,
    lastChange: Date.now(),
  };
  private persistence: PausePersistence | null = null;
  private recentTransitions: PauseTransition[] = [];
  private firstScanForceVpn = false;
  private bootstrapped = false;

  static getInstance(): PauseCoordinator {
    if (!this.instance) this.instance = new PauseCoordinator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  bootstrap(): void {
    if (this.bootstrapped) return;

    const persistence = this.getPersistence();
    if (!persistence) {
      this.bootstrapped = true;
      return;
    }

    const loaded = persistence.load();
    this.bootstrapped = true;

    if (loaded === null) return;

    if (loaded === 'corrupted') {
      this.replaceReasons(new Set<PauseReason>(['detector-error']), 'bootstrap:corrupted');
      this.firstScanForceVpn = true;
      return;
    }

    if (Date.now() - loaded.persistedAt > STALE_PERSISTED_MS) {
      persistence.clear();
      return;
    }

    this.recentTransitions = loaded.recentTransitions;
    const reasons = new Set<PauseReason>(loaded.reasons);
    if (reasons.has('vpn')) {
      reasons.delete('vpn');
      reasons.add('detector-error');
      this.firstScanForceVpn = true;
    } else if (reasons.has('detector-error')) {
      this.firstScanForceVpn = true;
    }

    this.replaceReasons(reasons, 'bootstrap:restore');
  }

  isPaused(): boolean {
    return this.state.isPaused;
  }

  getState(): Readonly<PauseState> {
    return {
      ...this.state,
      reasons: new Set(this.state.reasons),
    };
  }

  toPayload(): PauseStatePayload {
    return {
      isPaused: this.state.isPaused,
      reasons: [...this.state.reasons],
      pausedAt: this.state.pausedAt,
      lastChange: this.state.lastChange,
    };
  }

  needsFirstScanForceVpnTreatment(): boolean {
    return this.firstScanForceVpn;
  }

  consumeFirstScanFlag(): void {
    this.firstScanForceVpn = false;
  }

  reconcileFirstEvaluation(vpnActive: boolean): void {
    if (!this.firstScanForceVpn) return;
    this.firstScanForceVpn = false;

    if (!this.state.reasons.has('detector-error')) return;
    const next = new Set(this.state.reasons);
    next.delete('detector-error');
    if (vpnActive) next.add('vpn');
    this.replaceReasons(next, vpnActive ? 'first-evaluation:vpn' : 'first-evaluation:clean');
  }

  addReason(reason: PauseReason, meta?: Record<string, unknown>): void {
    if (this.state.reasons.has(reason)) return;
    const next = new Set(this.state.reasons);
    next.add(reason);
    this.replaceReasons(next, `add:${reason}`, meta);
  }

  removeReason(reason: PauseReason): void {
    if (!this.state.reasons.has(reason)) return;
    const next = new Set(this.state.reasons);
    next.delete(reason);
    this.replaceReasons(next, `remove:${reason}`);
  }

  removeReasons(reasons: readonly PauseReason[], trigger = 'remove:many'): void {
    const next = new Set(this.state.reasons);
    let changed = false;
    for (const reason of reasons) {
      if (next.delete(reason)) changed = true;
    }
    if (changed) this.replaceReasons(next, trigger);
  }

  clearAllReasons(trigger = 'clear:all'): void {
    this.firstScanForceVpn = false;

    if (this.state.reasons.size === 0) {
      this.bootstrapped = true;
      this.recentTransitions = [];
      this.getPersistence()?.clear();
      return;
    }

    this.replaceReasons(new Set<PauseReason>(), trigger);
    this.getPersistence()?.clear();
  }

  private replaceReasons(
    reasons: Set<PauseReason>,
    trigger: string,
    meta?: Record<string, unknown>
  ): void {
    const before = this.state;
    const wasPaused = before.isPaused;
    const from = [...before.reasons];
    const to = [...reasons];
    const now = Date.now();

    this.state = {
      isPaused: reasons.size > 0,
      reasons,
      pausedAt: reasons.size > 0 ? before.pausedAt ?? now : null,
      lastChange: now,
    };

    this.persist(from, to, trigger, meta);

    if (!wasPaused && this.state.isPaused) this.emit('pause', this.getState());
    if (wasPaused && !this.state.isPaused) this.emit('resume', this.getState());
    this.emit('change', this.getState());
  }

  private persist(
    from: PauseReason[],
    to: PauseReason[],
    trigger: string,
    _meta?: Record<string, unknown>
  ): void {
    this.recentTransitions = [
      ...this.recentTransitions,
      {
        at: Date.now(),
        from,
        to,
        trigger,
      },
    ].slice(-20);
    this.getPersistence()?.save({
      reasons: [...this.state.reasons],
      persistedAt: Date.now(),
      recentTransitions: this.recentTransitions,
    });
  }

  private getPersistence(): PausePersistence | null {
    if (this.persistence) return this.persistence;

    try {
      this.persistence = new PausePersistence();
      return this.persistence;
    } catch {
      return null;
    }
  }
}

export function getPauseCoordinator(): PauseCoordinator {
  return PauseCoordinator.getInstance();
}
