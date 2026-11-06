import { Injectable, OnDestroy, signal } from '@angular/core';

export interface ToastOptions {
  key?: string;
  action?: { label: string; run: () => void | Promise<void> };
  durationMs?: number;
}
export interface ToastMessage extends ToastOptions {
  id: string;
  text: string;
  type: 'success' | 'error';
}
interface ToastTimer {
  remaining: number;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  pauses: Set<'hover' | 'focus'>;
}
@Injectable({ providedIn: 'root' })
export class ToastService implements OnDestroy {
  readonly toasts = signal<ToastMessage[]>([]);
  private readonly timers = new Map<string, ToastTimer>();

  show(text: string, type: ToastMessage['type'] = 'success', options: ToastOptions = {}): string {
    if (options.key) this.dismissKey(options.key);
    const id = `${Date.now()}-${Math.random()}`;
    this.toasts.update((list) => [...list, { ...options, id, text, type }]);
    const plain = this.toasts().filter((toast) => !toast.action);
    for (const old of plain.slice(0, Math.max(0, plain.length - 3))) this.dismiss(old.id);
    const clock: ToastTimer = { remaining: options.durationMs ?? (options.action ? 5000 : 4000), started: Date.now(), pauses: new Set() };
    this.timers.set(id, clock); this.start(id, clock);
    return id;
  }
  pause(id: string, reason: 'hover' | 'focus'): void {
    const clock = this.timers.get(id);
    if (!clock || clock.pauses.has(reason)) return;
    if (clock.pauses.size === 0) {
      clearTimeout(clock.timer); clock.remaining = Math.max(0, clock.remaining - (Date.now() - clock.started));
    }
    clock.pauses.add(reason);
  }
  resume(id: string, reason: 'hover' | 'focus'): void {
    const clock = this.timers.get(id);
    if (clock?.pauses.delete(reason) && clock.pauses.size === 0) this.start(id, clock);
  }
  dismiss(id: string): void {
    clearTimeout(this.timers.get(id)?.timer); this.timers.delete(id);
    this.toasts.update((list) => list.filter((toast) => toast.id !== id));
  }
  dismissKey(key: string): void { for (const toast of this.toasts()) if (toast.key === key) this.dismiss(toast.id); }
  dismissAll(): void { for (const toast of this.toasts()) this.dismiss(toast.id); }
  ngOnDestroy(): void { this.dismissAll(); }
  private start(id: string, clock: ToastTimer): void {
    clock.started = Date.now(); clock.timer = setTimeout(() => this.dismiss(id), clock.remaining);
  }
}
