import { Injectable, signal } from '@angular/core';

export interface ToastMessage {
  id: string;
  text: string;
  type: 'success' | 'error';
}

const AUTO_DISMISS_MS = 2200;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<ToastMessage[]>([]);

  show(text: string, type: ToastMessage['type'] = 'success'): void {
    const id = `${Date.now()}-${Math.random()}`;
    this.toasts.update((list) => [...list, { id, text, type }]);
    setTimeout(() => this.dismiss(id), AUTO_DISMISS_MS);
  }

  dismiss(id: string): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
