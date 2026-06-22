import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { HostStore } from './host-store';
import type {
  MobileAttachmentDto,
  MobileClientEvent,
  MobileCreateInstanceRequest,
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileModelCatalog,
  MobileMessageDto,
  MobilePauseDto,
  MobilePromptDto,
  MobileRecentDirDto,
  MobileRespondRequest,
  MobileServerEvent,
  MobileSnapshot,
  PairedHost,
} from './models';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

const RECONNECT_MS = 3000;
/** Pairing must reach the host over Tailscale; bound it so the UI can't hang forever. */
const PAIR_TIMEOUT_MS = 10000;
const EMPTY_PAUSE: MobilePauseDto = { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };

/**
 * Maintains a live WebSocket to the active host and exposes the latest snapshot,
 * per-instance transcripts, pending prompts and pause state as signals. Reconnects
 * automatically (the WS link rides the Tailscale tunnel, which can drop as the phone
 * changes networks) and uses the per-instance `seq` to detect gaps and resync.
 * Zoneless-friendly: socket callbacks write signals, which drive change detection.
 */
@Injectable({ providedIn: 'root' })
export class GatewayClient {
  private readonly hostStore = inject(HostStore);

  private readonly _snapshot = signal<MobileSnapshot | null>(null);
  private readonly _state = signal<ConnectionState>('disconnected');
  private readonly _transcripts = signal<Record<string, MobileMessageDto[]>>({});
  private readonly _prompts = signal<MobilePromptDto[]>([]);
  private readonly _pause = signal<MobilePauseDto>(EMPTY_PAUSE);
  private readonly _history = signal<MobileHistorySessionDto[]>([]);
  private readonly _models = signal<MobileModelCatalog | null>(null);

  readonly snapshot = this._snapshot.asReadonly();
  readonly state = this._state.asReadonly();
  readonly online = computed(() => this._state() === 'connected');
  readonly transcripts = this._transcripts.asReadonly();
  readonly prompts = this._prompts.asReadonly();
  readonly pause = this._pause.asReadonly();
  /** Persisted sessions (chats + archived instance sessions), newest first. */
  readonly historySessions = this._history.asReadonly();
  readonly modelCatalog = this._models.asReadonly();

  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentHostId: string | null = null;
  private readonly lastSeq = new Map<string, number>();
  /**
   * The conversation the UI currently has open, reported up the WS so the gateway
   * suppresses the unread-completion dot for it. Retained so it can be re-sent
   * after a reconnect (the socket drops as the phone roams networks).
   */
  private activeView: string | null = null;

  constructor() {
    // (Re)connect whenever the active host changes.
    effect(() => {
      const host = this.hostStore.activeHost();
      if ((host?.id ?? null) !== this.currentHostId) {
        this.connect(host);
      }
    });
  }

  /** The transcript for one instance (history + live), or []. */
  messagesFor(instanceId: string): MobileMessageDto[] {
    return this._transcripts()[instanceId] ?? [];
  }

  /** Pending prompts for one instance. */
  promptsFor(instanceId: string): MobilePromptDto[] {
    return this._prompts().filter((p) => p.instanceId === instanceId);
  }

  /**
   * Report which conversation the UI has open (null when none) so the gateway
   * doesn't flag the unread-completion dot for a session the user is watching.
   * Cheap and idempotent — safe to call on every screen enter/leave.
   */
  setActiveView(instanceId: string | null): void {
    if (this.activeView === instanceId) return;
    this.activeView = instanceId;
    this.sendClientEvent({ type: 'view', instanceId });
  }

  /**
   * Clear the active view, but only if `instanceId` is still the one we reported.
   * Lets a conversation screen relinquish its view on teardown without clobbering
   * a newer screen that already claimed the view during a route transition.
   */
  clearActiveView(instanceId: string): void {
    if (this.activeView === instanceId) this.setActiveView(null);
  }

  private sendClientEvent(event: MobileClientEvent): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        /* best-effort; re-asserted on the next reconnect */
      }
    }
  }

  private connect(host: PairedHost | null): void {
    this.teardown();
    this.currentHostId = host?.id ?? null;
    this._snapshot.set(null);
    this._prompts.set([]);
    this._pause.set(EMPTY_PAUSE);
    this._transcripts.set({});
    this._models.set(null);
    this.lastSeq.clear();
    this._history.set([]);
    if (!host) {
      this._state.set('disconnected');
      return;
    }
    this.openSocket(host);
    void this.loadHistory();
  }

  /** Fetch the persisted session list (best-effort; leaves the cache on failure). */
  async loadHistory(): Promise<void> {
    try {
      this._history.set(await this.history());
    } catch {
      /* history is best-effort; the live snapshot still renders */
    }
  }

  private openSocket(host: PairedHost): void {
    this._state.set('connecting');
    const scheme = host.secure ? 'wss' : 'ws';
    const url = `${scheme}://${host.host}:${host.port}/ws?token=${encodeURIComponent(host.token)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect(host);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this._state.set('connected');
      // Re-assert which conversation is open so a reconnect doesn't resurrect the
      // dot for a session the user is still watching.
      if (this.activeView) this.sendClientEvent({ type: 'view', instanceId: this.activeView });
    };
    ws.onmessage = (ev: MessageEvent) => {
      try {
        this.handleEvent(JSON.parse(ev.data as string) as MobileServerEvent);
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

  private handleEvent(event: MobileServerEvent): void {
    switch (event.type) {
      case 'snapshot':
        this._snapshot.set(event.data);
        this._prompts.set(event.data.prompts ?? []);
        this._pause.set(event.data.pause ?? EMPTY_PAUSE);
        break;
      case 'instance-output':
        this.applyOutput(event.data.instanceId, event.data.seq, event.data.message);
        break;
      case 'permission-prompt':
        this.upsertPrompt(event.data);
        break;
      case 'permission-cleared':
        this._prompts.set(this._prompts().filter((p) => p.requestId !== event.data.requestId));
        break;
      case 'pause-state':
        this._pause.set(event.data);
        break;
      case 'instance-removed':
        this.dropInstance(event.data.instanceId);
        break;
      // instance-created / instance-state are also delivered via the coalesced
      // snapshot, which is the source of truth for the instance/project lists.
      default:
        break;
    }
  }

  private applyOutput(instanceId: string, seq: number, message: MobileMessageDto): void {
    const prev = this.lastSeq.get(instanceId);
    this.lastSeq.set(instanceId, seq);
    // Gap on a flaky link → pull authoritative history for this instance.
    if (prev !== undefined && seq > prev + 1) {
      void this.loadMessages(instanceId);
    }
    this.appendMessage(instanceId, message);
  }

  private appendMessage(instanceId: string, message: MobileMessageDto): void {
    const map = this._transcripts();
    const list = map[instanceId] ?? [];
    const existing = list.findIndex((m) => m.id === message.id);
    const next = existing >= 0
      ? list.map((m, i) => (i === existing ? message : m))
      : [...list, message];
    this._transcripts.set({ ...map, [instanceId]: next });
  }

  private upsertPrompt(prompt: MobilePromptDto): void {
    const others = this._prompts().filter((p) => p.id !== prompt.id);
    this._prompts.set([...others, prompt]);
  }

  private dropInstance(instanceId: string): void {
    const map = { ...this._transcripts() };
    delete map[instanceId];
    this._transcripts.set(map);
    this._prompts.set(this._prompts().filter((p) => p.instanceId !== instanceId));
    this.lastSeq.delete(instanceId);
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

  // ---------------------------------------------------------------------------
  // REST — every command goes to the active host with its bearer token.
  // ---------------------------------------------------------------------------

  private base(): { url: string; headers: Record<string, string> } | null {
    const host = this.hostStore.activeHost();
    if (!host) return null;
    const scheme = host.secure ? 'https' : 'http';
    return {
      url: `${scheme}://${host.host}:${host.port}`,
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.base();
    if (!base) throw new Error('No active host');
    const res = await fetch(`${base.url}${path}`, {
      method,
      headers: base.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  /** Fetch and store the authoritative transcript for an instance. */
  async loadMessages(instanceId: string): Promise<void> {
    try {
      const messages = await this.request<MobileMessageDto[]>(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/messages`,
      );
      this._transcripts.set({ ...this._transcripts(), [instanceId]: messages });
    } catch {
      /* leave any existing transcript in place */
    }
  }

  async sendInput(
    instanceId: string,
    message: string,
    attachments?: MobileAttachmentDto[],
  ): Promise<void> {
    // Optimistic echo so the user sees their message immediately.
    this.appendMessage(instanceId, {
      id: `local-${Date.now()}`,
      timestamp: Date.now(),
      type: 'user',
      content: message,
      hasAttachments: Boolean(attachments?.length),
    });
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/input`, {
      message,
      attachments,
    });
    // Reconcile with the authoritative buffer (drops the optimistic temp id).
    void this.loadMessages(instanceId);
  }

  async respond(instanceId: string, body: MobileRespondRequest): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/respond`, body);
    this._prompts.set(this._prompts().filter((p) => p.requestId !== body.requestId));
  }

  async interrupt(instanceId: string): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/interrupt`);
  }

  async terminate(instanceId: string, graceful = true): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/terminate`, {
      graceful,
    });
  }

  async rename(instanceId: string, displayName: string): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/rename`, {
      displayName,
    });
  }

  async models(): Promise<MobileModelCatalog> {
    const cached = this._models();
    if (cached) {
      return cached;
    }
    const catalog = await this.request<MobileModelCatalog>('GET', '/api/models');
    this._models.set(catalog);
    return catalog;
  }

  async changeModel(instanceId: string, model: string): Promise<MobileInstanceDto> {
    const updated = await this.request<MobileInstanceDto>(
      'POST',
      `/api/instances/${encodeURIComponent(instanceId)}/model`,
      { model },
    );
    this._snapshot.update((snapshot) =>
      snapshot
        ? {
            ...snapshot,
            instances: snapshot.instances.map((instance) =>
              instance.id === updated.id ? updated : instance,
            ),
          }
        : snapshot,
    );
    return updated;
  }

  async createInstance(body: MobileCreateInstanceRequest): Promise<MobileInstanceDto> {
    return this.request<MobileInstanceDto>('POST', '/api/instances', body);
  }

  async recentDirs(): Promise<MobileRecentDirDto[]> {
    return this.request<MobileRecentDirDto[]>('GET', '/api/recent-dirs');
  }

  /** Persisted sessions (live + archived), newest first. */
  async history(): Promise<MobileHistorySessionDto[]> {
    return this.request<MobileHistorySessionDto[]>('GET', '/api/history');
  }

  /** Transcript of one persisted session. */
  async historyMessages(chatId: string): Promise<MobileMessageDto[]> {
    return this.request<MobileMessageDto[]>(
      'GET',
      `/api/history/${encodeURIComponent(chatId)}/messages`,
    );
  }

  async setPause(paused: boolean): Promise<void> {
    const state = await this.request<MobilePauseDto>('POST', '/api/pause', { paused });
    this._pause.set(state);
  }

  async registerApnsToken(deviceId: string, apnsToken: string): Promise<void> {
    await this.request('POST', `/api/devices/${encodeURIComponent(deviceId)}/apns-token`, {
      apnsToken,
    });
  }

  /**
   * REST: exchange a one-time pairing token for a long-lived device token.
   *
   * The host is reached over the Tailscale tunnel; if Tailscale isn't connected
   * on the phone (or the Mac gateway is down) the request would otherwise hang
   * indefinitely, so we bound it with a timeout and surface a clear,
   * actionable error instead of spinning forever on "Pairing…".
   */
  static async pair(
    host: string,
    port: number,
    pairingToken: string,
    label: string,
    secure = false,
  ): Promise<{ deviceId: string; token: string; hostName: string; expiresAt: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
    const scheme = secure ? 'https' : 'http';
    let res: Response;
    try {
      res = await fetch(`${scheme}://${host}:${port}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingToken, label }),
        signal: controller.signal,
      });
    } catch {
      // AbortError (timeout) or a network failure both mean we never reached the
      // gateway — almost always Tailscale not being connected on the phone.
      throw new Error(
        `Couldn't reach ${host}:${port}. Check that Tailscale is connected on this phone ` +
          `(same tailnet as the Mac) and the gateway is running, then try again.`,
      );
    } finally {
      clearTimeout(timeout);
    }
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
