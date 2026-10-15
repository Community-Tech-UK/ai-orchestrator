import { powerSaveBlocker } from 'electron';
import type { KeepAwakeState } from '@contracts/schemas/observability';
import { getLogger } from '../logging/logger';

const logger = getLogger('KeepAwake');
export type KeepAwakeWorkReason = Exclude<KeepAwakeState['reason'], 'always' | null>;
const PRIORITY: readonly KeepAwakeWorkReason[] = ['loop', 'plan-queue', 'automation', 'session'];

interface KeepAwakeDependencies {
  getMode: () => KeepAwakeState['mode'];
  probes: readonly (() => readonly KeepAwakeWorkReason[])[];
  blocker?: Pick<typeof powerSaveBlocker, 'start' | 'stop'>;
  broadcast: (state: KeepAwakeState) => void;
  now?: () => number;
  subscribe?: (reconcile: () => void) => () => void;
}

export class KeepAwakeService {
  private static instance: KeepAwakeService | null = null;
  private dependencies: KeepAwakeDependencies | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private blockerId: number | null = null;
  private readonly failedProbes = new Set<number>();
  private state: KeepAwakeState = { mode: 'while-working', active: false, reason: null, since: null };

  static getInstance(): KeepAwakeService {
    return this.instance ??= new KeepAwakeService();
  }

  static _resetForTesting(): void {
    this.instance?.shutdown();
    this.instance = null;
  }

  initialize(dependencies: KeepAwakeDependencies): void {
    this.shutdown();
    this.dependencies = { ...dependencies, blocker: dependencies.blocker ?? powerSaveBlocker,
      now: dependencies.now ?? Date.now };
    this.failedProbes.clear();
    this.unsubscribe = dependencies.subscribe?.(() => this.reconcile()) ?? null;
    this.reconcile();
    this.timer = setInterval(() => this.reconcile(), 30_000);
    this.timer.unref?.();
  }

  reconcile(): void {
    const deps = this.dependencies;
    if (!deps) return;
    const mode = deps.getMode();
    const work = new Set<KeepAwakeWorkReason>();
    if (mode !== 'off') {
      deps.probes.forEach((probe, index) => {
        try {
          for (const reason of probe()) work.add(reason);
        } catch (error) {
          if (!this.failedProbes.has(index)) {
            this.failedProbes.add(index);
            logger.warn('Keep-awake probe failed', { probe: index,
              error: error instanceof Error ? error.message : String(error) });
          }
        }
      });
    }
    const reason = PRIORITY.find(candidate => work.has(candidate)) ?? (mode === 'always' ? 'always' : null);
    const want = mode === 'always' || (mode === 'while-working' && work.size > 0);
    try {
      if (want && this.blockerId === null) {
        this.blockerId = deps.blocker!.start('prevent-app-suspension');
      } else if (!want && this.blockerId !== null) {
        deps.blocker!.stop(this.blockerId);
        this.blockerId = null;
      }
    } catch (error) {
      logger.warn('Could not reconcile the keep-awake assertion', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const active = this.blockerId !== null;
    this.publish({ mode, active, reason: active ? reason : null,
      since: active ? (this.state.since ?? deps.now!()) : null });
  }

  getState(): KeepAwakeState {
    return { ...this.state };
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.blockerId !== null) {
      try { this.dependencies?.blocker?.stop(this.blockerId); }
      catch (error) { logger.warn('Could not release the keep-awake assertion', {
        error: error instanceof Error ? error.message : String(error),
      }); }
      this.blockerId = null;
    }
    this.publish({ ...this.state, active: false, reason: null, since: null });
    this.dependencies = null;
  }

  private publish(state: KeepAwakeState): void {
    const changed = state.active !== this.state.active || state.reason !== this.state.reason;
    this.state = state;
    if (changed) {
      try { this.dependencies?.broadcast(this.getState()); }
      catch (error) { logger.warn('Could not broadcast keep-awake state', {
        error: error instanceof Error ? error.message : String(error),
      }); }
    }
  }
}

export const getKeepAwakeService = (): KeepAwakeService => KeepAwakeService.getInstance();
