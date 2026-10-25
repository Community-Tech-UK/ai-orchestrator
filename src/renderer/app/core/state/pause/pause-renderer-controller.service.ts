import { effect, Injectable, inject, Injector } from '@angular/core';
import { SettingsStore } from '../settings.store';
import { PauseStore } from './pause.store';

@Injectable({ providedIn: 'root' })
export class PauseRendererController {
  private injector = inject(Injector);
  private settings = inject(SettingsStore);
  private pauseStore = inject(PauseStore);

  private pauseUnsubscribe: (() => void) | null = null;
  private bound = false;
  private started = false;
  private startPromise: Promise<void> | null = null;
  private generation = 0;

  bindReactive(): void {
    if (this.bound) return;
    this.bound = true;
    effect(
      () => {
        const shouldStart =
          this.settings.isInitialized() && this.settings.get('pauseFeatureEnabled');
        if (shouldStart) this.start();
        else this.stop();
      },
      { injector: this.injector }
    );
  }

  stop(): void {
    this.generation += 1;
    this.pauseUnsubscribe?.();
    this.pauseUnsubscribe = null;
    this.pauseStore.reset();
    this.started = false;
    this.startPromise = null;
  }

  private start(): void {
    if (this.started || this.startPromise) return;
    const generation = ++this.generation;
    this.startPromise = this.startAsync(generation)
      .catch((error) => {
        if (this.generation === generation) {
          console.warn('PauseRendererController: failed to start pause services', error);
          this.stop();
        }
      })
      .finally(() => {
        if (this.generation === generation) this.startPromise = null;
      });
  }

  private async startAsync(generation: number): Promise<void> {
    this.pauseUnsubscribe = this.pauseStore.onStateChanged();

    await this.pauseStore.refresh();
    if (!this.isStartCurrent(generation)) {
      this.pauseUnsubscribe?.();
      this.pauseUnsubscribe = null;
      return;
    }

    this.started = true;
  }

  private isStartCurrent(generation: number): boolean {
    return (
      this.generation === generation &&
      this.settings.isInitialized() &&
      this.settings.get('pauseFeatureEnabled')
    );
  }
}
