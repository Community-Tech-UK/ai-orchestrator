import { DOCUMENT } from '@angular/common';
import { inject, Injectable, signal } from '@angular/core';
import { LoopStore } from '../../core/state/loop.store';

@Injectable({ providedIn: 'root' })
export class LoopStopConfirmService {
  private readonly store = inject(LoopStore);
  private readonly document = inject(DOCUMENT);
  readonly pending = signal<{ loopId: string; isolated: boolean } | null>(null);
  readonly confirming = signal(false);
  readonly error = signal<string | null>(null);
  private chatId?: string;
  private afterStopped?: () => void;
  private returnFocus: HTMLElement | null = null;

  request(loopId: string, isolated = false, options?: { chatId?: string; afterStopped?: () => void }): void {
    if (this.confirming()) return;
    this.chatId = options?.chatId;
    this.afterStopped = options?.afterStopped;
    this.returnFocus = this.document.activeElement instanceof HTMLElement ? this.document.activeElement : null;
    this.error.set(null);
    this.pending.set({ loopId, isolated });
  }

  async confirm(): Promise<void> {
    const request = this.pending();
    if (!request || this.confirming()) return;
    this.confirming.set(true);
    try {
      await this.store.cancel(request.loopId);
      if (this.chatId && this.store.activeForChat(this.chatId)()?.id === request.loopId) {
        this.error.set('The loop could not be stopped. Try again.');
        return;
      }
      const afterStopped = this.afterStopped;
      this.clear();
      afterStopped?.();
    } catch {
      this.error.set('The loop could not be stopped. Try again.');
    } finally { this.confirming.set(false); }
  }

  dismiss(): void {
    if (!this.confirming()) this.clear();
  }

  private clear(): void {
    this.pending.set(null);
    this.error.set(null);
    this.afterStopped = undefined;
    this.chatId = undefined;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }
}
