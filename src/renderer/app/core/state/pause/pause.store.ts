import { computed, Injectable, signal, inject } from '@angular/core';
import type { PauseReason, PauseStatePayload } from '@contracts/schemas/pause';
import { PauseIpcService } from '../../services/ipc/pause-ipc.service';

export interface ResumeEvent {
  id: number;
  at: number;
  queuedTotal: number;
}

const RUNNING_STATE: PauseStatePayload = {
  isPaused: false,
  reasons: [],
  pausedAt: null,
  lastChange: Date.now(),
};

@Injectable({ providedIn: 'root' })
export class PauseStore {
  private ipc = inject(PauseIpcService);
  private stateSignal = signal<PauseStatePayload>(RUNNING_STATE);
  private resumeEventsSignal = signal<ResumeEvent[]>([]);
  private resumeEventId = 0;

  readonly state = this.stateSignal.asReadonly();
  readonly isPaused = computed(() => this.stateSignal().isPaused);
  readonly reasons = computed(() => this.stateSignal().reasons);
  readonly manualPaused = computed(() => this.stateSignal().reasons.includes('user'));
  readonly detectorError = computed(() => this.stateSignal().reasons.includes('detector-error'));
  readonly queuedTotal = signal(0);
  readonly resumeEvents = this.resumeEventsSignal.asReadonly();

  async refresh(): Promise<void> {
    const response = await this.ipc.pauseGetState();
    if (response.success && response.data) {
      this.applyState(response.data);
    }
  }

  async setManual(paused: boolean): Promise<void> {
    const response = await this.ipc.pauseSetManual(paused);
    if (response.success && response.data) {
      this.applyState(response.data);
    }
  }

  async resumeAfterDetectorError(): Promise<void> {
    const response = await this.ipc.pauseDetectorResumeAfterError();
    if (response.success && response.data) {
      this.applyState(response.data);
    }
  }

  onStateChanged(callback?: (state: PauseStatePayload) => void): () => void {
    return this.ipc.onPauseStateChanged((state) => {
      this.applyState(state);
      callback?.(state);
    });
  }

  applyState(state: PauseStatePayload): void {
    const previous = this.stateSignal();
    this.stateSignal.set({
      ...state,
      reasons: [...state.reasons] as PauseReason[],
    });
    if (previous.isPaused && !state.isPaused && this.queuedTotal() > 0) {
      this.resumeEventsSignal.update((events) => [
        ...events.slice(-4),
        {
          id: ++this.resumeEventId,
          at: Date.now(),
          queuedTotal: this.queuedTotal(),
        },
      ]);
    }
  }

  reset(): void {
    this.stateSignal.set({ ...RUNNING_STATE, lastChange: Date.now() });
    this.queuedTotal.set(0);
  }
}
