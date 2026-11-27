import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface ConfirmRequest {
  options: Required<ConfirmOptions>;
  resolve: (answer: boolean) => void;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly active = signal<Required<ConfirmOptions> | null>(null);
  readonly pending = this.active.asReadonly();
  private readonly requests: ConfirmRequest[] = [];

  /**
   * Ask a question. When `withdrawn` fires before it is answered (the question no longer describes what is on
   * screen), it is taken down, or dropped from the queue, and answered no.
   */
  confirm(options: ConfirmOptions, withdrawn?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (withdrawn?.aborted) {
        resolve(false);
        return;
      }
      const request: ConfirmRequest = { options: { title: 'Confirm', cancelLabel: 'Cancel', danger: false, ...options }, resolve };
      this.requests.push(request);
      if (!this.active()) this.active.set(this.requests[0]!.options);
      withdrawn?.addEventListener('abort', () => this.withdraw(request), { once: true });
    });
  }

  resolve(confirmed: boolean): void {
    const request = this.requests.shift();
    this.active.set(this.requests[0]?.options ?? null);
    request?.resolve(confirmed);
  }

  cancelAll(): void {
    const requests = this.requests.splice(0);
    this.active.set(null);
    for (const request of requests) request.resolve(false);
  }

  private withdraw(request: ConfirmRequest): void {
    const index = this.requests.indexOf(request);
    if (index < 0) return; // Already answered.
    this.requests.splice(index, 1);
    if (index === 0) this.active.set(this.requests[0]?.options ?? null);
    request.resolve(false);
  }
}
