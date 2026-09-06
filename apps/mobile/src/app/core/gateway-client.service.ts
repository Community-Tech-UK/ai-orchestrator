import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { authFailureMessage } from './connection-status';
import { HostStore } from './host-store';
import type {
  MobileAttachmentDto,
  MobileClientEvent,
  MobileCreateInstanceRequest,
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileModelCatalog,
  MobileMessageDto,
  MobileSessionPlan,
  MobilePauseDto,
  MobilePromptDto,
  MobileRecentDirDto,
  MobileReasoningEffort,
  MobileRespondRequest,
  MobileServerEvent,
  MobileSnapshot,
  PairedHost,
} from './models';

/**
 * `unauthorized` means the host answered but rejected our device token (expired or
 * revoked): re-pairing is the only fix, so it must not be reported as a network
 * problem.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'unauthorized';

const RECONNECT_MS = 3000;
/** Retry cadence once the token is known bad — retrying fast cannot help. */
const UNAUTHORIZED_RETRY_MS = 30000;
/** Bound the post-failure auth probe so a black-holed host can't stall reconnects. */
const AUTH_PROBE_TIMEOUT_MS = 5000;
const EMPTY_PAUSE: MobilePauseDto = { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };
const LOCAL_MESSAGE_ID_PREFIX = 'local-';
const LOCAL_ECHO_REPLACE_WINDOW_MS = 2 * 60_000;

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
  /**
   * Bumped on every teardown so an in-flight auth probe from a previous
   * connection can tell it has been superseded. The host id alone is not enough:
   * switching away from a host and back lands on the same id.
   */
  private connectGeneration = 0;

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
    let opened = false;

    ws.onopen = () => {
      opened = true;
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
        if (opened) {
          this.scheduleReconnect(host);
        } else {
          // Never completed the handshake — find out whether that was the network
          // or a rejected token before deciding what to tell the user.
          void this.diagnoseFailedHandshake(host);
        }
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
    const optimisticEcho =
      existing >= 0 ? -1 : findOptimisticUserEchoIndex(list, message);
    const replaceIndex = existing >= 0 ? existing : optimisticEcho;
    const next =
      replaceIndex >= 0
        ? list.map((m, i) => (i === replaceIndex ? message : m))
        : [...list, message];
    this._transcripts.set({ ...map, [instanceId]: next });
  }

  /** Drop a transcript entry by id (used to retract an optimistic echo). */
  private removeMessage(instanceId: string, messageId: string): void {
    const map = this._transcripts();
    const list = map[instanceId];
    if (!list) return;
    const next = list.filter((m) => m.id !== messageId);
    if (next.length === list.length) return;
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

  private scheduleReconnect(host: PairedHost, delayMs: number = RECONNECT_MS): void {
    if (this.reconnectTimer || this.currentHostId !== host.id) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.currentHostId === host.id) {
        this.openSocket(host);
      }
    }, delayMs);
  }

  /**
   * A browser WebSocket surfaces a rejected handshake as a bare close event: the
   * gateway's 401 for an expired or revoked device token is invisible, so an auth
   * failure and an unreachable host look identical and both got blamed on
   * Tailscale. REST does expose the status, so probe an authenticated endpoint and
   * classify the failure before scheduling the next attempt.
   */
  private async diagnoseFailedHandshake(host: PairedHost): Promise<void> {
    const generation = this.connectGeneration;
    let unauthorized = false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_PROBE_TIMEOUT_MS);
    try {
      const scheme = host.secure ? 'https' : 'http';
      const res = await fetch(`${scheme}://${host.host}:${host.port}/api/snapshot`, {
        headers: { authorization: `Bearer ${host.token}` },
        signal: controller.signal,
      });
      unauthorized = res.status === 401 || res.status === 403;
    } catch {
      // Aborted or a network failure: we never reached the host, so this is a
      // genuine connectivity problem and 'disconnected' already describes it.
    } finally {
      clearTimeout(timeout);
    }
    // A reconnect, or a whole new connection, may have landed while the probe was
    // in flight; neither should be overwritten by this stale result.
    if (
      this.connectGeneration !== generation ||
      this.currentHostId !== host.id ||
      this._state() === 'connected'
    ) {
      return;
    }
    if (unauthorized) {
      this._state.set('unauthorized');
    }
    this.scheduleReconnect(host, unauthorized ? UNAUTHORIZED_RETRY_MS : RECONNECT_MS);
  }

  private teardown(): void {
    this.connectGeneration += 1;
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

  private base(): { url: string; headers: Record<string, string>; hostId: string } | null {
    const host = this.hostStore.activeHost();
    if (!host) return null;
    const scheme = host.secure ? 'https' : 'http';
    return {
      url: `${scheme}://${host.host}:${host.port}`,
      headers: { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' },
      // Retained so a slow response can tell whether it still speaks for the
      // host the user is actually looking at.
      hostId: host.id,
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
      if (res.status === 401) {
        // The token is dead for every endpoint, not just this one, so converge the
        // whole app on the state that names the real fix and replace the gateway's
        // bare "Unauthorized" — which screens rendered verbatim — with something
        // the user can act on. Only speak for the active host: a slow response
        // from a host the user has since switched away from must not label a
        // healthy connection as expired.
        if (this.hostStore.activeHost()?.id === base.hostId) {
          this._state.set('unauthorized');
        }
        throw new Error(authFailureMessage());
      }
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

  /**
   * Send a message. When the session is mid-turn the host parks it instead
   * (`queued`), and it goes out on the next ready edge.
   *
   * The optimistic echo is removed again unless the message really was sent:
   * leaving it behind after a rejected send is what made a failed message look
   * like it had been sent *and* left a copy in the composer.
   */
  async sendInput(
    instanceId: string,
    message: string,
    attachments?: MobileAttachmentDto[],
  ): Promise<{ queued: boolean }> {
    const echoId = `${LOCAL_MESSAGE_ID_PREFIX}${Date.now()}`;
    this.appendMessage(instanceId, {
      id: echoId,
      timestamp: Date.now(),
      type: 'user',
      content: message,
      hasAttachments: Boolean(attachments?.length),
    });
    let result: { queued?: boolean };
    try {
      result = await this.request<{ queued?: boolean }>(
        'POST',
        `/api/instances/${encodeURIComponent(instanceId)}/input`,
        { message, attachments },
      );
    } catch (err) {
      this.removeMessage(instanceId, echoId);
      throw err;
    }
    if (result?.queued) {
      // The queue strip owns it now — it isn't in the transcript yet, and the
      // host emits the real user bubble when it delivers.
      this.removeMessage(instanceId, echoId);
      return { queued: true };
    }
    // Reconcile with the authoritative buffer (drops the optimistic temp id).
    void this.loadMessages(instanceId);
    return { queued: false };
  }

  /** Cancel a parked message. Returns its text so the UI can restore the draft. */
  async cancelQueued(instanceId: string, queueId: string): Promise<string> {
    const result = await this.request<{ message?: string }>(
      'DELETE',
      `/api/instances/${encodeURIComponent(instanceId)}/queue/${encodeURIComponent(queueId)}`,
    );
    return result?.message ?? '';
  }

  async respond(instanceId: string, body: MobileRespondRequest): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/respond`, body);
    this._prompts.set(this._prompts().filter((p) => p.requestId !== body.requestId));
  }

  /**
   * Respond to an approval straight from a push-notification action. The push
   * carries the sending Mac's hostname, so this routes to that paired host
   * even when it isn't the active one (multi-host phones), without needing
   * the app UI or WebSocket to be up.
   */
  async respondFromPush(
    hostName: string | undefined,
    instanceId: string,
    body: MobileRespondRequest,
  ): Promise<void> {
    const hosts = this.hostStore.hosts();
    const target =
      (hostName && hosts.find((h) => h.name.toLowerCase() === hostName.toLowerCase())) ||
      this.hostStore.activeHost() ||
      hosts[0];
    if (!target) throw new Error('No paired host');
    const scheme = target.secure ? 'https' : 'http';
    const res = await fetch(
      `${scheme}://${target.host}:${target.port}/api/instances/${encodeURIComponent(instanceId)}/respond`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.status === 401) {
        // A push can target a host other than the one we're connected to, so only
        // reflect the dead token globally when it is the active host.
        if (target.id === this.hostStore.activeHost()?.id) this._state.set('unauthorized');
        throw new Error(authFailureMessage());
      }
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    this._prompts.set(this._prompts().filter((p) => p.requestId !== body.requestId));
  }

  /**
   * Ask the host to stop the running turn. `accepted` is false when the session
   * had nothing interruptible — the UI says so rather than looking like it worked.
   */
  async interrupt(instanceId: string): Promise<{ accepted: boolean }> {
    const result = await this.request<{ accepted?: boolean }>(
      'POST',
      `/api/instances/${encodeURIComponent(instanceId)}/interrupt`,
    );
    return { accepted: result?.accepted !== false };
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

  /**
   * Preview which provider/model/thinking a new session would start with, given
   * the chosen provider ('auto' or specific) and optional model override. The
   * host resolves it because it depends on the host's installed CLIs + settings.
   */
  async sessionPlan(
    provider: string,
    model?: string,
    reasoningEffort?: MobileReasoningEffort,
  ): Promise<MobileSessionPlan> {
    const params = new URLSearchParams({ provider });
    if (model) params.set('model', model);
    if (reasoningEffort) params.set('reasoningEffort', reasoningEffort);
    return this.request<MobileSessionPlan>('GET', `/api/session-plan?${params.toString()}`);
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

  /** Register (or clear, with an empty token) a session's Live Activity push token. */
  async registerLiveActivityToken(
    deviceId: string,
    instanceId: string,
    token: string,
  ): Promise<void> {
    await this.request('POST', `/api/devices/${encodeURIComponent(deviceId)}/live-activity-token`, {
      instanceId,
      token,
    });
  }

}

function findOptimisticUserEchoIndex(
  messages: MobileMessageDto[],
  incoming: MobileMessageDto,
): number {
  if (incoming.id.startsWith(LOCAL_MESSAGE_ID_PREFIX) || incoming.type !== 'user') {
    return -1;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isOptimisticEchoOf(messages[index], incoming)) {
      return index;
    }
  }
  return -1;
}

function isOptimisticEchoOf(local: MobileMessageDto, incoming: MobileMessageDto): boolean {
  if (!local.id.startsWith(LOCAL_MESSAGE_ID_PREFIX) || local.type !== 'user') {
    return false;
  }
  if (local.content !== incoming.content) {
    return false;
  }
  if (Boolean(local.hasAttachments) !== Boolean(incoming.hasAttachments)) {
    return false;
  }
  return timestampsAreClose(local.timestamp, incoming.timestamp);
}

function timestampsAreClose(localTimestamp: number, incomingTimestamp: number): boolean {
  if (!Number.isFinite(localTimestamp) || !Number.isFinite(incomingTimestamp)) {
    return true;
  }
  return Math.abs(localTimestamp - incomingTimestamp) <= LOCAL_ECHO_REPLACE_WINDOW_MS;
}
