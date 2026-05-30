import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HostStore } from './host-store';
import type { MobileServerEvent, MobileSnapshot, PairedHost } from './models';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const RECONNECT_MS = 3000;

/**
 * Maintains a live WebSocket to the active host and exposes the latest snapshot
 * as a signal. Reconnects automatically (the WS link rides the Tailscale tunnel,
 * which can drop as the phone changes networks). Zoneless-friendly: socket
 * callbacks write signals, which drive change detection directly.
 */
@Injectable({ providedIn: 'root' })
export class GatewayClient {
  private readonly hostStore = inject(HostStore);

  private readonly _snapshot = signal<MobileSnapshot | null>(null);
  private readonly _state = signal<ConnectionState>('disconnected');

  readonly snapshot = this._snapshot.asReadonly();
  readonly state = this._state.asReadonly();
  readonly online = computed(() => this._state() === 'connected');

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentHostId: string | null = null;

  constructor() {
    // (Re)connect whenever the active host changes.
    effect(() => {
      const host = this.hostStore.activeHost();
      if ((host?.id ?? null) !== this.currentHostId) {
        this.connect(host);
      }
    });
  }

  private connect(host: PairedHost | null): void {
    this.teardown();
    this.currentHostId = host?.id ?? null;
    this._snapshot.set(null);
    if (!host) {
      this._state.set('disconnected');
      return;
    }
    this.openSocket(host);
  }

  private openSocket(host: PairedHost): void {
    this._state.set('connecting');
    const url = `ws://${host.host}:${host.port}/ws?token=${encodeURIComponent(host.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(host);
      return;
    }
    this.ws = ws;

    ws.onopen = () => this._state.set('connected');
    ws.onmessage = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(ev.data as string) as MobileServerEvent;
        if (event.type === 'snapshot') {
          this._snapshot.set(event.data);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
        this._state.set('disconnected');
        this.scheduleReconnect(host);
      }
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(host: PairedHost): void {
    if (this.reconnectTimer || this.currentHostId !== host.id) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentHostId === host.id) {
        this.openSocket(host);
      }
    }, RECONNECT_MS);
  }

  private teardown(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (ws) {
      this.ws = null;
      // Detach handlers so the close below doesn't trigger a reconnect.
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  /** REST: exchange a one-time pairing token for a long-lived device token. */
  static async pair(
    host: string,
    port: number,
    pairingToken: string,
    label: string,
  ): Promise<{ deviceId: string; token: string; hostName: string; expiresAt: number }> {
    const res = await fetch(`http://${host}:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken, label }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Pairing failed (HTTP ${res.status})`);
    }
    return (await res.json()) as {
      deviceId: string;
      token: string;
      hostName: string;
      expiresAt: number;
    };
  }
}
