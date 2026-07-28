import {
  DestroyRef,
  Injectable,
  Injector,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';

@Injectable({ providedIn: 'root' })
export class LocalAiModalCoordinator {
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly _activeKey = signal<string | null>(null);
  private readonly focusTargets = new Map<string, () => HTMLElement | null>();
  private readonly pendingFocusTimers = new Set<ReturnType<typeof setTimeout>>();
  readonly activeKey = this._activeKey.asReadonly();

  constructor() {
    this.destroyRef.onDestroy(() => {
      for (const timer of this.pendingFocusTimers) clearTimeout(timer);
      this.pendingFocusTimers.clear();
    });
  }

  open(key: string): void {
    this._activeKey.set(key);
  }

  close(key: string): void {
    if (this._activeKey() === key) this._activeKey.set(null);
  }

  registerFocusTarget(key: string, resolveTarget: () => HTMLElement | null): () => void {
    this.focusTargets.set(key, resolveTarget);
    return () => {
      if (this.focusTargets.get(key) === resolveTarget) this.focusTargets.delete(key);
    };
  }

  closeAndRestore(
    key: string,
    preferred: (() => HTMLElement | null) | undefined,
    fallbacks: readonly string[],
  ): void {
    this.close(key);
    this.restoreAfterRender(preferred, fallbacks);
  }

  restoreAfterRender(
    preferred: (() => HTMLElement | null) | undefined,
    fallbacks: readonly string[],
  ): void {
    let settled = false;
    const focusState: { timer?: ReturnType<typeof setTimeout> } = {};
    const restore = () => {
      if (settled) return;
      const preferredTarget = preferred?.();
      if (preferredTarget?.isConnected) {
        preferredTarget.focus();
        settled = true;
        if (focusState.timer !== undefined) this.clearFocusTimer(focusState.timer);
        return;
      }
      for (const key of fallbacks) {
        const target = this.focusTargets.get(key)?.();
        if (!target?.isConnected) continue;
        target.focus();
        settled = true;
        if (focusState.timer !== undefined) this.clearFocusTimer(focusState.timer);
        return;
      }
    };
    afterNextRender(restore, { injector: this.injector });
    const timer = setTimeout(() => {
      this.pendingFocusTimers.delete(timer);
      restore();
    }, 0);
    focusState.timer = timer;
    this.pendingFocusTimers.add(timer);
  }

  private clearFocusTimer(timer: ReturnType<typeof setTimeout>): void {
    clearTimeout(timer);
    this.pendingFocusTimers.delete(timer);
  }
}
