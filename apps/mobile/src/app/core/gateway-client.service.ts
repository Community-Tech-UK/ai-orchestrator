import { IDLE_LOAD, LOADING, LOADED, failedLoad, friendlyRequestError, withRequestDeadline, type MobileLoadState } from './gateway-request-state';
import { LOCAL_MESSAGE_ID_PREFIX } from './mobile-optimistic-echo';
import { Injectable, effect, inject, signal } from '@angular/core';
import { authFailureMessage } from './connection-status';
import { HostStore } from './host-store';
import { GatewaySocket } from './gateway-socket';
import { sendPushResponse } from './gateway-push-request';
import { TranscriptStore } from './transcript-store';
import type {
  MobileAttachmentDto,
  MobileCancelledInputDto,
  MobileCreateInstanceRequest,
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileModelCatalog,
  MobileMessageDto,
  MobileMessagesResumeDto,
  MobileSessionPlan,
  MobilePauseDto,
  MobilePromptDto,
  MobileRecentDirDto,
  MobileReasoningEffort,
  MobileRespondRequest,
  MobileServerEvent,
  MobileSnapshot,
} from './models';

export type { ConnectionState } from './gateway-socket';
const EMPTY_PAUSE: MobilePauseDto = { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 };

@Injectable({ providedIn: 'root' })
export class GatewayClient {
  private readonly hostStore = inject(HostStore);
  private readonly socket = new GatewaySocket();
  private readonly transcriptStore = new TranscriptStore();

  private readonly _snapshot = signal<MobileSnapshot | null>(null);
  private readonly _prompts = signal<MobilePromptDto[]>([]);
  private readonly _pause = signal<MobilePauseDto>(EMPTY_PAUSE);
  private readonly _history = signal<MobileHistorySessionDto[]>([]);
  private readonly _models = signal<MobileModelCatalog | null>(null);
  private readonly _dataHostId = signal<string | null>(null);
  private readonly _historyState = signal<MobileLoadState>(IDLE_LOAD);
  private readonly _modelState = signal<MobileLoadState>(IDLE_LOAD);
  private historyLoad = 0;

  readonly snapshot = this._snapshot.asReadonly();
  readonly state = this.socket.state;
  readonly online = this.socket.online;
  readonly lastServerFrameAt = this.socket.lastServerFrameAt;
  readonly transcripts = this.transcriptStore.transcripts;
  readonly prompts = this._prompts.asReadonly();
  readonly pause = this._pause.asReadonly();
  readonly historySessions = this._history.asReadonly();
  readonly modelCatalog = this._models.asReadonly();
  readonly dataHostId = this._dataHostId.asReadonly();
  readonly historyState = this._historyState.asReadonly();
  readonly modelState = this._modelState.asReadonly();

  constructor() {
    effect(() => {
      const host = this.hostStore.activeHost();
      if ((host?.id ?? null) !== this.socket.hostId) {
        this.connect(host);
      }
    });
  }

  messagesFor(instanceId: string): MobileMessageDto[] { return this.transcriptStore.messagesFor(instanceId); }

  messageStateFor(instanceId: string): MobileLoadState { return this.transcriptStore.messageStateFor(instanceId); }

  reconnect(): void {
    const host = this.hostStore.activeHost();
    if (!host) return;
    if (host.id !== this.socket.hostId) { this.connect(host); return; }
    this.socket.reconnect(host);
    void this.loadHistory();
  }

  promptsFor(instanceId: string): MobilePromptDto[] {
    return this._prompts().filter((p) => p.instanceId === instanceId);
  }

  setActiveView(instanceId: string | null): void { this.socket.setActiveView(instanceId); }

  clearActiveView(instanceId: string): void { this.socket.clearActiveView(instanceId); }

  private connect(host: ReturnType<HostStore['activeHost']>): void {
    this.socket.connect(
      host,
      (event) => this.handleEvent(event),
      (instanceId) => { void this.resumeMessages(instanceId); },
    );
    this._snapshot.set(null);
    this._prompts.set([]);
    this._pause.set(EMPTY_PAUSE);
    this.transcriptStore.reset();
    this._models.set(null);
    this._history.set([]);
    this._historyState.set(IDLE_LOAD);
    this._modelState.set(IDLE_LOAD);
    this.historyLoad += 1;
    this._dataHostId.set(host?.id ?? null);
    if (host) void this.loadHistory();
  }

  async loadHistory(): Promise<void> {
    const scope = this.requestScope();
    const load = ++this.historyLoad;
    this._historyState.set(LOADING);
    try {
      const sessions = await this.history();
      if (!scope() || this.historyLoad !== load) return;
      this._history.set(sessions);
      this._historyState.set(LOADED);
    } catch (error) {
      if (scope() && this.historyLoad === load) this._historyState.set(failedLoad(error));
    }
  }

  private handleEvent(event: MobileServerEvent): void {
    switch (event.type) {
      case 'snapshot':
        this._snapshot.set(event.data);
        this._prompts.set(event.data.prompts ?? []);
        this._pause.set(event.data.pause ?? EMPTY_PAUSE);
        break;
      case 'instance-output':
        this.applyOutput(event.data);
        break;
      case 'permission-prompt':
        this.upsertPrompt(event.data);
        break;
      case 'permission-cleared':
        this._prompts.update((prompts) => prompts.filter((p) => p.requestId !== event.data.requestId ||
          (event.data.instanceId !== undefined && p.instanceId !== event.data.instanceId)));
        break;
      case 'pause-state':
        this._pause.set(event.data);
        break;
      case 'instance-removed':
        this.dropInstance(event.data.instanceId);
        break;
      default:
        break;
    }
  }

  private applyOutput(data: Extract<MobileServerEvent, { type: 'instance-output' }>['data']): void {
    const recovery = this.transcriptStore.applyOutput(data.instanceId, {
      legacySeq: data.seq,
      streamSeq: data.streamSeq,
      bufferIndex: data.bufferIndex,
      bufferGeneration: data.bufferGeneration,
      cursorEpoch: data.cursorEpoch,
      adapterGeneration: data.adapterGeneration,
    }, data.message);
    if (recovery === 'full') void this.loadMessages(data.instanceId);
    if (recovery === 'resume') void this.resumeMessages(data.instanceId);
  }

  private upsertPrompt(prompt: MobilePromptDto): void {
    const others = this._prompts().filter((p) => p.id !== prompt.id);
    this._prompts.set([...others, prompt]);
  }

  private dropInstance(instanceId: string): void {
    this.transcriptStore.dropInstance(instanceId);
    this._prompts.set(this._prompts().filter((p) => p.instanceId !== instanceId));
  }

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

  private async request<T>(method: string, path: string, body?: unknown, allowStaleResult = false): Promise<T> {
    const base = this.base();
    if (!base) throw new Error('No active host');
    const current = this.requestScope();
    return withRequestDeadline(async (signal) => {
      let res: Response;
      try {
        res = await fetch(`${base.url}${path}`, {
          method, headers: base.headers, signal,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new Error('The connection to this host was interrupted. Check the connection before trying again.');
      }
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        if (res.status === 401) {
          if (current() && !signal.aborted) this.socket.markUnauthorized();
          throw new Error(authFailureMessage());
        }
        throw new Error(friendlyRequestError(err.error, res.status));
      }
      const value = await res.json() as T;
      if (!current() && !allowStaleResult) throw new Error('The active host changed. Return to the original host to check the result.');
      return value;
    });
  }

  private requestScope(): () => boolean {
    const id = this.hostStore.activeHost()?.id;
    const generation = this.socket.generation;
    return () => this.hostStore.activeHost()?.id === id && this.socket.generation === generation;
  }

  /** Fetch and store the authoritative transcript for an instance. */
  async loadMessages(instanceId: string): Promise<void> {
    const current = this.requestScope();
    await this.transcriptStore.loadMessages(instanceId,
      () => this.request<MobileMessageDto[] | MobileMessagesResumeDto>(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/messages?withCursor=1`,
      ),
      current);
  }

  private async resumeMessages(instanceId: string): Promise<void> {
    const fromSeq = this.transcriptStore.resumeFromBufferIndex(instanceId);
    if (fromSeq === undefined) {
      await this.loadMessages(instanceId);
      return;
    }
    const current = this.requestScope();
    await this.transcriptStore.resumeMessages(
      instanceId,
      () => this.request<MobileMessagesResumeDto>(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/messages?fromSeq=${fromSeq}&includeFrom=1`,
      ),
      () => this.request<MobileMessageDto[] | MobileMessagesResumeDto>(
        'GET',
        `/api/instances/${encodeURIComponent(instanceId)}/messages?withCursor=1`,
      ),
      current,
    );
  }

  /** Retract optimistic input on rejection/queueing; reconcile confirmed delivery. */
  async sendInput(
    instanceId: string,
    message: string,
    attachments?: MobileAttachmentDto[],
  ): Promise<{ queued: boolean }> {
    const current = this.requestScope();
    const echoId = `${LOCAL_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`;
    this.transcriptStore.appendMessage(instanceId, {
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
        true,
      );
    } catch (err) {
      if (current()) this.transcriptStore.removeMessage(instanceId, echoId);
      throw err;
    }
    // The sending screen owns its original draft even after navigation. Return
    // the acknowledgement without loading or removing data on the new host.
    if (!current()) return { queued: result?.queued === true };
    if (result?.queued) {
      // The queue strip owns it now — it isn't in the transcript yet, and the
      // host emits the real user bubble when it delivers.
      this.transcriptStore.removeMessage(instanceId, echoId);
      return { queued: true };
    }
    // Reconcile with the authoritative buffer (drops the optimistic temp id).
    void this.loadMessages(instanceId);
    return { queued: false };
  }

  /** Recover a parked draft, including attachments; delivery conflicts reject. */
  async cancelQueued(instanceId: string, queueId: string): Promise<MobileCancelledInputDto> {
    const current = this.requestScope();
    const result = await this.request<MobileCancelledInputDto>(
      'DELETE',
      `/api/instances/${encodeURIComponent(instanceId)}/queue/${encodeURIComponent(queueId)}`,
      undefined,
      true,
    );
    if (current()) this._snapshot.update((snapshot) => snapshot ? {
      ...snapshot,
      instances: snapshot.instances.map((instance) => instance.id === instanceId ? {
        ...instance,
        queuedMessages: instance.queuedMessages?.filter((item) => item.id !== queueId),
      } : instance),
    } : snapshot);
    return { message: result.message, ...(result.attachments ? { attachments: result.attachments } : {}) };
  }

  async respond(instanceId: string, body: MobileRespondRequest): Promise<void> {
    const current = this.requestScope();
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/respond`, body);
    if (current()) this._prompts.update((prompts) => prompts.filter((p) => p.requestId !== body.requestId || p.instanceId !== instanceId));
  }

  /** Route a push action by stable device id, with hostname only for legacy payloads. */
  async respondFromPush(
    hostDeviceId: string | undefined,
    hostName: string | undefined,
    instanceId: string,
    body: MobileRespondRequest,
  ): Promise<void> {
    const targetId = await sendPushResponse({
      hosts: this.hostStore.hosts(), hostDeviceId, hostName, instanceId, body,
      onUnauthorized: (id) => {
        if (id === this.hostStore.activeHost()?.id) this.socket.markUnauthorized();
      },
    });
    if (targetId === this.hostStore.activeHost()?.id && targetId === this._dataHostId()) {
      this._prompts.update((prompts) => prompts.filter((p) => p.requestId !== body.requestId || p.instanceId !== instanceId));
    }
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
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/terminate`, { graceful });
  }

  async rename(instanceId: string, displayName: string): Promise<void> {
    await this.request('POST', `/api/instances/${encodeURIComponent(instanceId)}/rename`, { displayName });
  }

  async models(): Promise<MobileModelCatalog> {
    const cached = this._models();
    if (cached) {
      return cached;
    }
    const current = this.requestScope();
    this._modelState.set(LOADING);
    try {
      const catalog = await this.request<MobileModelCatalog>('GET', '/api/models');
      if (current()) { this._models.set(catalog); this._modelState.set(LOADED); }
      return catalog;
    } catch (error) {
      if (current()) this._modelState.set(failedLoad(error));
      throw error;
    }
  }

  async changeModel(instanceId: string, model: string): Promise<MobileInstanceDto> {
    const current = this.requestScope();
    const updated = await this.request<MobileInstanceDto>(
      'POST',
      `/api/instances/${encodeURIComponent(instanceId)}/model`,
      { model },
    );
    if (current()) this._snapshot.update((snapshot) =>
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

  async liveInstances(): Promise<MobileInstanceDto[]> { return this.request('GET', '/api/instances'); }

  async createInstance(body: MobileCreateInstanceRequest): Promise<MobileInstanceDto> {
    return this.request('POST', '/api/instances', body);
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

  async recentDirs(): Promise<MobileRecentDirDto[]> { return this.request('GET', '/api/recent-dirs'); }

  /** Persisted sessions (live + archived), newest first. */
  async history(): Promise<MobileHistorySessionDto[]> { return this.request('GET', '/api/history'); }

  /** Transcript of one persisted session. */
  async historyMessages(chatId: string): Promise<MobileMessageDto[]> {
    return this.request<MobileMessageDto[]>(
      'GET',
      `/api/history/${encodeURIComponent(chatId)}/messages`,
    );
  }

  async setPause(paused: boolean): Promise<void> {
    const current = this.requestScope();
    const state = await this.request<MobilePauseDto>('POST', '/api/pause', { paused });
    if (current()) this._pause.set(state);
  }

  async registerApnsToken(deviceId: string, apnsToken: string): Promise<void> {
    await this.request('POST', `/api/devices/${encodeURIComponent(deviceId)}/apns-token`, { apnsToken });
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
