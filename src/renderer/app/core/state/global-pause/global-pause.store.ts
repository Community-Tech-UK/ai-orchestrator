import { Injectable, inject, signal, OnDestroy } from '@angular/core';
import { GlobalPauseStateSchema, type GlobalPauseState } from '@contracts/schemas/global-pause';
import { GlobalPauseIpcService, type GlobalPauseCommand } from '../../services/ipc/global-pause-ipc.service';

const INITIAL_STATE: GlobalPauseState = {
  phase: 'none', since: null, reason: null, batchId: null, heldInstanceIds: [], entries: [],
  completedNotes: 0, totalNotes: 0, resumeInterrupted: false, stale: false, summary: null,
};

@Injectable({ providedIn: 'root' })
export class GlobalPauseStore implements OnDestroy {
  private readonly ipc = inject(GlobalPauseIpcService);
  private readonly current = signal(INITIAL_STATE);
  private readonly failure = signal<string | null>(null);
  private readonly stateUnavailable = signal(false);
  readonly state = this.current.asReadonly();
  readonly error = this.failure.asReadonly();
  private unsubscribe: (() => void) | null = null;
  private initialization: Promise<void> | null = null;
  private revision = 0;
  private destroyed = false;

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.unsubscribe = this.ipc.onStateChanged(state => {
      if (this.destroyed) return;
      this.revision++;
      this.stateUnavailable.set(false);
      this.current.set(state);
    });
    const revision = this.revision;
    this.initialization = this.ipc.getState().then(result => {
      if (this.destroyed || this.revision !== revision) return;
      if (!result.success) {
        this.stateUnavailable.set(true);
        this.failure.set('Could not read the work controls. Reopen the panel to try again.');
        this.initialization = null;
        this.unsubscribe?.();
        this.unsubscribe = null;
        return;
      }
      const parsed = GlobalPauseStateSchema.safeParse(result.data);
      if (parsed.success) {
        this.current.set(parsed.data);
        this.stateUnavailable.set(false);
        this.failure.set(null);
      } else {
        this.stateUnavailable.set(true);
        this.failure.set('Could not read the work controls. Reopen the panel to try again.');
        this.initialization = null;
        this.unsubscribe?.(); this.unsubscribe = null;
      }
    }).catch(() => {
      this.stateUnavailable.set(true);
      this.failure.set('Could not read the work controls. Reopen the panel to try again.');
      this.initialization = null;
      this.unsubscribe?.();
      this.unsubscribe = null;
    });
    return this.initialization;
  }

  holdsAutomaticInput(id: string): boolean {
    return this.stateUnavailable() || this.current().heldInstanceIds.includes(id);
  }

  refresh(): Promise<void> {
    this.unsubscribe?.(); this.unsubscribe = null;
    this.initialization = null;
    return this.initialize();
  }

  async pickUp(id: string): Promise<boolean> {
    if (!this.holdsAutomaticInput(id)) return true;
    await this.command('pick-up', { instanceId: id });
    return !this.holdsAutomaticInput(id);
  }

  async command(command: GlobalPauseCommand, payload?: unknown): Promise<void> {
    this.failure.set(null);
    const revision = this.revision;
    try {
      const result = await this.ipc.command(command, payload);
      if (this.destroyed) return;
      if (!result.success) {
        this.failure.set(result.error?.message ?? 'The work control could not finish. Try again.');
        return;
      }
      const parsed = GlobalPauseStateSchema.safeParse(result.data);
      if (parsed.success && revision === this.revision) {
        this.stateUnavailable.set(false);
        this.current.set(parsed.data);
      }
    } catch {
      this.failure.set('The work control could not finish. Try again.');
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
