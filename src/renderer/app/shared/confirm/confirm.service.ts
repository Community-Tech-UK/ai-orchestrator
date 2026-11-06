import { Injectable, signal } from '@angular/core';

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
}

@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly active = signal<Required<ConfirmOptions> | null>(null);
  readonly pending = this.active.asReadonly();
  private readonly requests: { options: Required<ConfirmOptions>; resolve: (answer: boolean) => void }[] = [];

  confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      this.requests.push({ options: { title: 'Confirm', cancelLabel: 'Cancel', danger: false, ...options }, resolve });
      if (!this.active()) this.active.set(this.requests[0]!.options);
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
}
