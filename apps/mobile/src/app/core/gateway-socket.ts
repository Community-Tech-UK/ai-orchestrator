import { computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import type { MobileClientEvent, MobileServerEvent, PairedHost } from './models';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const;
const RECONNECT_JITTER = 0.2;
const UNAUTHORIZED_RETRY_MS = 30000;
const AUTH_PROBE_TIMEOUT_MS = 5000;
const FOREGROUND_PONG_TIMEOUT_MS = 3000;

/** Owns one host's WebSocket, its reconnect timer, and the visible-session report. */
export class GatewaySocket {
  private readonly _state = signal<ConnectionState>('disconnected');
  readonly state = this._state.asReadonly();
  readonly online = computed(() => this._state() === 'connected');
  private readonly _lastServerFrameAt = signal<number | null>(null);
  readonly lastServerFrameAt = this._lastServerFrameAt.asReadonly();

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private currentHostId: string | null = null;
  private currentHost: PairedHost | null = null;
  private activeView: string | null = null;
  private onEvent: (event: MobileServerEvent) => void = () => undefined;
  private onCatchUp: (instanceId: string) => void = () => undefined;
  private connectGeneration = 0;
  private reconnectAttempt = 0;
  private needsCatchUp = false;

  get hostId(): string | null { return this.currentHostId; }
  get generation(): number { return this.connectGeneration; }

  constructor() {
    if (Capacitor.isNativePlatform()) {
      void import('@capacitor/app').then(({ App }) =>
        App.addListener('appStateChange', ({ isActive }) => {
          if (isActive) this.checkForegroundLiveness();
          else this.clearPongTimer();
        }),
      );
    }
  }

  connect(
    host: PairedHost | null,
    onEvent: (event: MobileServerEvent) => void,
    onCatchUp: (instanceId: string) => void = () => undefined,
  ): void {
    this.teardown();
    this._lastServerFrameAt.set(null);
    this.currentHostId = host?.id ?? null;
    this.currentHost = host;
    this.activeView = null;
    this.onEvent = onEvent;
    this.onCatchUp = onCatchUp;
    this.reconnectAttempt = 0;
    this.needsCatchUp = false;
    if (host) this.openSocket(host);
    else this._state.set('disconnected');
  }

  reconnect(host: PairedHost): void {
    this.teardown();
    this.currentHost = host;
    this.needsCatchUp = true;
    this.openSocket(host);
  }

  setActiveView(instanceId: string | null): void {
    if (this.activeView === instanceId) return;
    this.activeView = instanceId;
    this.sendClientEvent({ type: 'view', instanceId });
  }

  clearActiveView(instanceId: string): void {
    if (this.activeView === instanceId) this.setActiveView(null);
  }

  markUnauthorized(): void {
    const host = this.currentHost;
    this.teardown();
    this.needsCatchUp = true;
    this._state.set('unauthorized');
    if (host) this.scheduleReconnect(host, UNAUTHORIZED_RETRY_MS);
  }

  private sendClientEvent(event: MobileClientEvent): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(event)); }
      catch { /* best effort; the view is reasserted after reconnect */ }
    }
  }

  private openSocket(host: PairedHost): void {
    this._state.set('connecting');
    const scheme = host.secure ? 'wss' : 'ws';
    const url = `${scheme}://${host.host}:${host.port}/ws?token=${encodeURIComponent(host.token)}`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); }
    catch { this.scheduleReconnect(host); return; }
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this._state.set('connected');
      this.reconnectAttempt = 0;
      if (this.activeView) this.sendClientEvent({ type: 'view', instanceId: this.activeView });
      if (this.needsCatchUp && this.activeView) this.onCatchUp(this.activeView);
      this.needsCatchUp = false;
    };
    ws.onmessage = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data as string) as MobileServerEvent;
        this._lastServerFrameAt.set(Date.now());
        if (parsed.type === 'pong') this.clearPongTimer();
        else this.onEvent(parsed);
      }
      catch { /* ignore malformed frame */ }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._state.set('disconnected');
      this.clearPongTimer();
      if (opened) {
        this.needsCatchUp = true;
        this.scheduleReconnect(host);
      }
      else void this.diagnoseFailedHandshake(host);
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* ignore */ }
    };
  }

  private scheduleReconnect(host: PairedHost, delayMs?: number): void {
    if (this.reconnectTimer || this.currentHostId !== host.id) return;
    const delay = delayMs ?? this.nextReconnectDelay();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentHostId === host.id) this.openSocket(host);
    }, delay);
  }

  /** A failed browser handshake hides its status; REST reveals a rejected token. */
  private async diagnoseFailedHandshake(host: PairedHost): Promise<void> {
    const generation = this.connectGeneration;
    let unauthorized = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
    try {
      const scheme = host.secure ? 'https' : 'http';
      const response = await fetch(`${scheme}://${host.host}:${host.port}/api/snapshot`, {
        headers: { authorization: `Bearer ${host.token}` }, signal: controller.signal,
      });
      unauthorized = response.status === 401 || response.status === 403;
    } catch {
      // Aborted or unreachable: disconnected already describes the network state.
    } finally { clearTimeout(timeout); }
    if (this.connectGeneration !== generation || this.currentHostId !== host.id || this._state() === 'connected') return;
    if (unauthorized) this._state.set('unauthorized');
    this.scheduleReconnect(host, unauthorized ? UNAUTHORIZED_RETRY_MS : undefined);
  }

  private nextReconnectDelay(): number {
    const base = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    const factor = 1 + ((Math.random() * 2) - 1) * RECONNECT_JITTER;
    return Math.round(base * factor);
  }

  private checkForegroundLiveness(): void {
    const host = this.currentHost;
    if (!host || this._state() === 'unauthorized') return;
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || this._state() !== 'connected') {
      this.reconnect(host);
      return;
    }
    this.clearPongTimer();
    this.sendClientEvent({ type: 'ping', sentAt: Date.now() });
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.currentHostId === host.id) this.reconnect(host);
    }, FOREGROUND_PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (!this.pongTimer) return;
    clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private teardown(): void {
    this.connectGeneration += 1;
    this.clearPongTimer();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    ws.onopen = null;
    try { ws.close(); } catch { /* ignore */ }
  }
}
