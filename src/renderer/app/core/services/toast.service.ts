import { Injectable, OnDestroy, computed, signal } from '@angular/core';

export interface ToastOptions {
  key?: string;
  action?: { label: string; run: () => void | Promise<void> };
  durationMs?: number;
}
export interface ToastMessage extends ToastOptions {
  id: string;
  text: string;
  type: 'success' | 'warning' | 'error';
  /** How many times this same notice (same key) was raised while it stayed on screen. */
  repeatCount: number;
}
interface ToastTimer {
  remaining: number;
  started: number;
  timer?: ReturnType<typeof setTimeout>;
  pauses: Set<'hover' | 'focus'>;
}

/** Toasts shown at once; the rest wait behind "N more". */
const VISIBLE_TOASTS = 3;
const PLAIN_TOAST_MS = 4000;
const ACTION_TOAST_MS = 5000;
const WARNING_TOAST_MS = 8000;

@Injectable({ providedIn: 'root' })
export class ToastService implements OnDestroy {
  readonly toasts = signal<ToastMessage[]>([]);
  /** Errors first (they stay until closed), then the newest others, at most three. */
  readonly visibleToasts = computed(() => [...this.toasts()]
    .sort((a, b) => Number(b.type === 'error') - Number(a.type === 'error')).slice(0, VISIBLE_TOASTS));
  readonly overflowCount = computed(() => Math.max(0, this.toasts().length - VISIBLE_TOASTS));
  private readonly timers = new Map<string, ToastTimer>();

  /**
   * An error stays until it is closed, unless the caller gives it a lifetime.
   * The same key raised again folds into the toast already shown and counts the repeat.
   */
  show(text: string, type: ToastMessage['type'] = 'success', options: ToastOptions = {}): string {
    const key = options.key ?? text;
    const existing = this.toasts().find((toast) => toast.key === key);
    const id = existing?.id ?? `${Date.now()}-${Math.random()}`;
    const message: ToastMessage = { ...options, key, id, text, type, repeatCount: (existing?.repeatCount ?? 0) + 1 };
    this.toasts.update((list) => existing ? list.map((toast) => toast.id === id ? message : toast) : [...list, message]);
    if (!existing) this.dropOldPlainToasts();
    clearTimeout(this.timers.get(id)?.timer); this.timers.delete(id);
    const lifetime = options.durationMs
      ?? (type === 'error' ? undefined : type === 'warning' ? WARNING_TOAST_MS : options.action ? ACTION_TOAST_MS : PLAIN_TOAST_MS);
    if (lifetime !== undefined) {
      const clock: ToastTimer = { remaining: lifetime, started: Date.now(), pauses: new Set() };
      this.timers.set(id, clock); this.start(id, clock);
    }
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
  /** What "+N more" offers: clears the notices on screen, so the hidden ones, errors included, come forward instead of being dropped unseen. */
  dismissVisible(): void { for (const toast of this.visibleToasts()) this.dismiss(toast.id); }
  dismissAll(): void { for (const toast of this.toasts()) this.dismiss(toast.id); }
  ngOnDestroy(): void { this.dismissAll(); }
  private start(id: string, clock: ToastTimer): void {
    clock.started = Date.now(); clock.timer = setTimeout(() => this.dismiss(id), clock.remaining);
  }
  /** More than three plain notices wait for no one: the oldest go. Errors and action toasts are never dropped here. */
  private dropOldPlainToasts(): void {
    const plain = this.toasts().filter((toast) => !toast.action && toast.type !== 'error');
    for (const old of plain.slice(0, Math.max(0, plain.length - VISIBLE_TOASTS))) this.dismiss(old.id);
  }
}
