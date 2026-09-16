/**
 * Cross-Session Messaging Store — messageable-session lookups and the send
 * action for both the "Message this session…" composer (user-initiated) and
 * any renderer surface that needs to know which live instances are currently
 * addressable. See `src/main/instance/cross-session-messaging.ts` for the
 * main-process gate this thinly wraps over IPC.
 */

import { Injectable, inject, signal } from '@angular/core';
import { IpcFacadeService } from '../../services/ipc';
import type {
  CrossSessionMessageResult,
  MessageableSession,
} from '@contracts/schemas/instance';

@Injectable({ providedIn: 'root' })
export class CrossSessionMessagingStore {
  private readonly ipc = inject(IpcFacadeService);

  private readonly _messageableSessions = signal<MessageableSession[]>([]);
  readonly messageableSessions = this._messageableSessions.asReadonly();

  private readonly _loading = signal(false);
  readonly loading = this._loading.asReadonly();

  private readonly _lastError = signal<string | null>(null);
  readonly lastError = this._lastError.asReadonly();

  /** Refreshes the list of instances addressable from `sourceInstanceId`, with reasons for the unreachable ones. */
  async refresh(sourceInstanceId: string): Promise<void> {
    this._loading.set(true);
    try {
      const response = await this.ipc.instance.listMessageableSessions(sourceInstanceId);
      if (response.success && response.data) {
        this._messageableSessions.set(response.data);
        this._lastError.set(null);
      } else {
        this._lastError.set(response.error?.message ?? 'Failed to list messageable sessions');
      }
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Delivers `message` into `targetNameOrId` from `sourceInstanceId`. Always
   * resolves with the discriminated outcome (never throws for a normal
   * rejection) so the composer can show *why* a send failed.
   */
  async send(
    sourceInstanceId: string,
    targetNameOrId: string,
    message: string,
  ): Promise<CrossSessionMessageResult | { outcome: 'error'; message: string }> {
    const response = await this.ipc.instance.sendCrossSessionMessage(
      sourceInstanceId,
      targetNameOrId,
      message,
    );
    if (response.success && response.data) {
      return response.data;
    }
    return { outcome: 'error', message: response.error?.message ?? 'Send failed' };
  }
}
