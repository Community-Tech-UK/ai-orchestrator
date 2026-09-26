import { signal, untracked } from '@angular/core';
import { IDLE_LOAD, LOADING, LOADED, failedLoad, type MobileLoadState } from './gateway-request-state';
import { findOptimisticUserEchoIndex } from './mobile-optimistic-echo';
import type { MobileMessageDto, MobileMessagesResumeDto } from './models';
import { buildDisplayItems } from '../shared/transcript-items';

export interface MobileOutputCursor {
  legacySeq: number;
  streamSeq?: number;
  bufferIndex?: number;
  bufferGeneration?: number;
  cursorEpoch?: string;
  adapterGeneration?: number;
}

export type TranscriptRecovery = 'resume' | 'full' | null;
type FullTranscriptPayload = MobileMessageDto[] | MobileMessagesResumeDto;
const MAX_FULL_LOAD_ATTEMPTS = 3;

interface TranscriptCursorState {
  legacySeq?: number;
  streamSeq?: number;
  bufferIndex?: number;
  bufferGeneration?: number;
  cursorEpoch?: string;
  adapterGeneration?: number;
}

interface OlderMessagesState {
  beforeSeq: number;
  /** End of known authoritative coverage, independent of newer live frames. */
  throughSeq: number;
  generation: TranscriptCursorState | undefined;
  hasMore: boolean;
  state: MobileLoadState;
}

/** Host-scoped live transcripts and their per-instance replay/load state. */
export class TranscriptStore {
  private readonly _transcripts = signal<Record<string, MobileMessageDto[]>>({});
  private readonly _messageStates = signal<Record<string, MobileLoadState>>({});
  private readonly cursors = new Map<string, TranscriptCursorState>();
  private readonly liveMessageStreamSeq = new Map<string, Map<string, number>>();
  private readonly resumeFrom = new Map<string, number>();
  private readonly messageLoads = new Map<string, number>();
  private readonly older = signal<Record<string, OlderMessagesState>>({});

  readonly transcripts = this._transcripts.asReadonly();

  reset(): void {
    this._transcripts.set({});
    this._messageStates.set({});
    this.cursors.clear();
    this.liveMessageStreamSeq.clear();
    this.resumeFrom.clear();
    this.messageLoads.clear();
    this.older.set({});
  }

  messagesFor(instanceId: string): MobileMessageDto[] {
    return this._transcripts()[instanceId] ?? [];
  }

  messageStateFor(instanceId: string): MobileLoadState {
    return this._messageStates()[instanceId] ?? IDLE_LOAD;
  }

  hasEarlierFor(instanceId: string): boolean { return this.older()[instanceId]?.hasMore ?? false; }
  earlierStateFor(instanceId: string): MobileLoadState { return this.older()[instanceId]?.state ?? IDLE_LOAD; }

  /** Older pages never move the live/reconnect watermark backwards. */
  async loadEarlier(
    instanceId: string,
    request: (beforeSeq: number) => Promise<MobileMessagesResumeDto>,
    isCurrent: () => boolean,
  ): Promise<void> {
    const initial = this.older()[instanceId];
    if (!initial?.hasMore || initial.state.status === 'loading') return;
    const load = this.messageLoads.get(instanceId);
    const state = { ...initial, state: LOADING };
    this.older.update(all => ({ ...all, [instanceId]: state }));
    const current = () => isCurrent() && this.messageLoads.get(instanceId) === load && this.older()[instanceId] === state;
    let beforeSeq = initial.beforeSeq;
    let hasMore = true;
    const additions: MobileMessageDto[] = [];
    const existing = this.messagesFor(instanceId);
    const existingItems = buildDisplayItems(existing).length;
    try {
      // Two 100-entry pages normally supply the next 150 display items. Hidden
      // records may need further requests; each response must advance the cursor.
      while (hasMore && buildDisplayItems([...additions, ...existing]).length - existingItems < 150) {
        const page = await request(beforeSeq);
        if (!current()) return;
        if (fullPayloadConflicts(this.cursors.get(instanceId), page.meta)) {
          throw new Error('The transcript changed while loading earlier messages. Refresh the conversation.');
        }
        const next = page.meta.nextBeforeSeq ?? page.messages[0]?.seq ?? beforeSeq;
        if (page.meta.hasMore && next >= beforeSeq) throw new Error('Earlier messages did not advance. Try refreshing the conversation.');
        additions.unshift(...page.messages);
        beforeSeq = next;
        hasMore = page.meta.hasMore;
      }
      this._transcripts.update(all => ({ ...all, [instanceId]: mergeMessages(additions, all[instanceId] ?? []) }));
      this.older.update(all => ({ ...all, [instanceId]: { ...initial, beforeSeq, hasMore, state: LOADED } }));
    } catch (error) {
      if (current()) this.older.update(all => ({ ...all, [instanceId]: { ...initial, state: failedLoad(error) } }));
    } finally {
      // Replay can supersede this request without replacing the older-page
      // state. Release only the state object owned by this request: a dropped
      // or reloaded instance (or a newer request) must remain untouched.
      this.older.update(all => all[instanceId] === state
        ? { ...all, [instanceId]: { ...initial, state: failedLoad(new Error(
          'The conversation refreshed while loading earlier messages. Try again.',
        )) } }
        : all);
    }
  }

  /** Apply a live frame and say whether the client needs replay or a full reset. */
  applyOutput(
    instanceId: string,
    cursor: MobileOutputCursor,
    message: MobileMessageDto,
  ): TranscriptRecovery {
    const previous = this.cursors.get(instanceId);
    const generationBoundary = previous !== undefined && (
      cursorEpochChanged(previous.cursorEpoch, cursor.cursorEpoch) ||
      generationChanged(previous.adapterGeneration, cursor.adapterGeneration) ||
      generationChanged(previous.bufferGeneration, cursor.bufferGeneration)
    );
    if (generationBoundary) this.liveMessageStreamSeq.delete(instanceId);
    // An HTTP replay can overtake a WebSocket frame that was already in flight.
    // Within the same generation, frames at or below the replay/live watermark
    // are duplicates or stale revisions and must not mutate content or cursors.
    if (!generationBoundary && cursor.streamSeq !== undefined &&
        previous?.streamSeq !== undefined && cursor.streamSeq <= previous.streamSeq) {
      return null;
    }
    const nextMessage = cursor.bufferIndex === undefined
      ? message
      : { ...message, seq: cursor.bufferIndex };
    this.appendMessage(instanceId, nextMessage);
    if (cursor.streamSeq !== undefined) {
      let revisions = this.liveMessageStreamSeq.get(instanceId);
      if (!revisions) {
        revisions = new Map<string, number>();
        this.liveMessageStreamSeq.set(instanceId, revisions);
      }
      revisions.set(nextMessage.id, cursor.streamSeq);
    }
    this.cursors.set(instanceId, { ...cursor });

    if (generationBoundary) return 'full';

    if (cursor.streamSeq === undefined || cursor.bufferIndex === undefined) {
      return previous?.legacySeq !== undefined && cursor.legacySeq > previous.legacySeq + 1 ? 'full' : null;
    }
    if (!previous || previous.streamSeq === undefined) return null;
    if (cursor.bufferIndex < (previous.bufferIndex ?? cursor.bufferIndex)) return 'full';
    if (cursor.streamSeq > previous.streamSeq + 1) {
      if (previous.bufferIndex !== undefined && !this.resumeFrom.has(instanceId)) {
        this.resumeFrom.set(instanceId, previous.bufferIndex);
      }
      return 'resume';
    }
    return null;
  }

  resumeFromBufferIndex(instanceId: string): number | undefined {
    return this.resumeFrom.get(instanceId) ?? this.cursors.get(instanceId)?.bufferIndex;
  }

  appendMessage(instanceId: string, message: MobileMessageDto): void {
    const map = this._transcripts();
    const list = map[instanceId] ?? [];
    const existing = list.findIndex((item) => item.id === message.id);
    const optimisticEcho = existing >= 0 ? -1 : findOptimisticUserEchoIndex(list, message);
    const replaceIndex = existing >= 0 ? existing : optimisticEcho;
    const next = replaceIndex >= 0
      ? list.map((item, index) => index === replaceIndex ? message : item)
      : [...list, message];
    this._transcripts.set({ ...map, [instanceId]: next });
  }

  removeMessage(instanceId: string, messageId: string): void {
    const map = this._transcripts();
    const list = map[instanceId];
    if (!list) return;
    const next = list.filter((message) => message.id !== messageId);
    if (next.length !== list.length) this._transcripts.set({ ...map, [instanceId]: next });
  }

  dropInstance(instanceId: string): void {
    const map = { ...this._transcripts() };
    delete map[instanceId];
    this._transcripts.set(map);
    this.cursors.delete(instanceId);
    this.liveMessageStreamSeq.delete(instanceId);
    this.resumeFrom.delete(instanceId);
    this.messageLoads.delete(instanceId);
    this.older.update(all => { const next = { ...all }; delete next[instanceId]; return next; });
    this._messageStates.update((states) => {
      const next = { ...states };
      delete next[instanceId];
      return next;
    });
  }

  /** Retain frames received while the authoritative HTTP replay was in flight. */
  async loadMessages(
    instanceId: string,
    request: () => Promise<FullTranscriptPayload>,
    isCurrent: () => boolean,
  ): Promise<void> {
    const load = (this.messageLoads.get(instanceId) ?? 0) + 1;
    this.messageLoads.set(instanceId, load);
    const initial = new Map(untracked(() => this.messagesFor(instanceId)).map((message) => [message.id, message]));
    this._messageStates.update((states) => ({ ...states, [instanceId]: LOADING }));
    try {
      const payload = await this.requestCompatibleFullTranscript(
        instanceId,
        request,
        () => isCurrent() && this.messageLoads.get(instanceId) === load,
      );
      if (!payload) return;
      const messages = this.fullMessagesWithEarlier(instanceId, payload);
      const merged = mergeMessages(
        messages,
        this.messagesFor(instanceId).filter((message) =>
          initial.get(message.id) !== message &&
          this.isNewerThanWatermark(instanceId, message, Array.isArray(payload) ? undefined : payload.meta.streamSeq, true)),
      );
      this._transcripts.update((transcripts) => ({ ...transcripts, [instanceId]: merged }));
      this.updateFullCursor(instanceId, messages.at(-1)?.seq, Array.isArray(payload) ? undefined : payload.meta);
      this._messageStates.update((states) => ({ ...states, [instanceId]: LOADED }));
      this.resumeFrom.delete(instanceId);
    } catch (error) {
      if (isCurrent() && this.messageLoads.get(instanceId) === load) {
        this._messageStates.update((states) => ({ ...states, [instanceId]: failedLoad(error) }));
      }
    }
  }

  async resumeMessages(
    instanceId: string,
    request: () => Promise<MobileMessagesResumeDto>,
    fullRequest: () => Promise<FullTranscriptPayload>,
    isCurrent: () => boolean,
  ): Promise<void> {
    const load = (this.messageLoads.get(instanceId) ?? 0) + 1;
    this.messageLoads.set(instanceId, load);
    const initial = new Map(
      untracked(() => this.messagesFor(instanceId)).map((message) => [message.id, message]),
    );
    this._messageStates.update((states) => ({ ...states, [instanceId]: LOADING }));
    try {
      const replay = await request();
      if (!isCurrent() || this.messageLoads.get(instanceId) !== load) return;
      const current = this.cursors.get(instanceId);
      const generationMismatch =
        cursorEpochChanged(current?.cursorEpoch, replay.meta.cursorEpoch) ||
        generationChanged(current?.bufferGeneration, replay.meta.bufferGeneration) ||
        generationChanged(current?.adapterGeneration, replay.meta.adapterGeneration);
      if (replay.meta.hasMore || replay.meta.bufferReset === true || generationMismatch) {
        const transition = generationMismatch ? { from: current, to: replay.meta } : undefined;
        const payload = await this.requestCompatibleFullTranscript(
          instanceId,
          fullRequest,
          () => isCurrent() && this.messageLoads.get(instanceId) === load,
          transition,
        );
        if (!payload) return;
        const messages = this.fullMessagesWithEarlier(instanceId, payload);
        const merged = mergeMessages(
          messages,
          this.messagesFor(instanceId).filter((message) =>
            initial.get(message.id) !== message &&
            this.isNewerThanWatermark(instanceId, message, Array.isArray(payload) ? undefined : payload.meta.streamSeq, true)),
        );
        this._transcripts.update((transcripts) => ({ ...transcripts, [instanceId]: merged }));
        this.updateFullCursor(instanceId, messages.at(-1)?.seq, Array.isArray(payload) ? undefined : payload.meta);
      } else {
        const currentMessages = this.messagesFor(instanceId);
        const mergedFromServer = mergeMessages(currentMessages, replay.messages);
        const newerLive = currentMessages.filter((message) =>
          this.isNewerThanWatermark(instanceId, message, replay.meta.streamSeq, false));
        const merged = mergeMessages(mergedFromServer, newerLive);
        this._transcripts.update((transcripts) => ({ ...transcripts, [instanceId]: merged }));
        this.updateReplayCursor(instanceId, replay.meta);
      }
      this._messageStates.update((states) => ({ ...states, [instanceId]: LOADED }));
      this.resumeFrom.delete(instanceId);
    } catch (error) {
      if (isCurrent() && this.messageLoads.get(instanceId) === load) {
        this._messageStates.update((states) => ({ ...states, [instanceId]: failedLoad(error) }));
      }
    }
  }

  private updateBufferIndex(instanceId: string, value: number | undefined): void {
    if (value === undefined) return;
    const current = this.cursors.get(instanceId);
    if (!current) {
      this.cursors.set(instanceId, { bufferIndex: value });
      return;
    }
    current.bufferIndex = Math.max(current.bufferIndex ?? value, value);
  }

  private fullMessagesWithEarlier(instanceId: string, payload: FullTranscriptPayload): MobileMessageDto[] {
    const messages = Array.isArray(payload) ? payload : payload.messages;
    const previous = this.older()[instanceId];
    const nextBeforeSeq = Array.isArray(payload) ? messages[0]?.seq ?? 0 : payload.meta.nextBeforeSeq ?? messages[0]?.seq ?? 0;
    // A live cursor (or isolated live message) may have jumped over missing
    // output. Only the prior authoritative range can prove that its prefix
    // reaches this capped snapshot. Otherwise restart paging at the new window.
    const compatible = !Array.isArray(payload) && previous?.generation &&
      sameGeneration(previous.generation, payload.meta) && nextBeforeSeq <= previous.throughSeq + 1;
    const prefix = compatible ? this.messagesFor(instanceId).filter(message => message.seq !== undefined && message.seq < nextBeforeSeq) : [];
    this.older.update(all => ({ ...all, [instanceId]: {
      beforeSeq: prefix.length && previous ? previous.beforeSeq : nextBeforeSeq,
      throughSeq: Array.isArray(payload) ? messages.at(-1)?.seq ?? -1 : payload.meta.maxSeq,
      generation: Array.isArray(payload) ? undefined : {
        bufferGeneration: payload.meta.bufferGeneration,
        cursorEpoch: payload.meta.cursorEpoch,
        adapterGeneration: payload.meta.adapterGeneration,
      },
      hasMore: prefix.length && previous ? previous.hasMore : Array.isArray(payload) ? nextBeforeSeq > 0 : payload.meta.hasMore,
      state: LOADED,
    } }));
    return prefix.length ? [...prefix, ...messages] : messages;
  }

  private updateReplayCursor(instanceId: string, meta: MobileMessagesResumeDto['meta']): void {
    this.updateBufferIndex(instanceId, meta.maxSeq);
    const current = this.cursors.get(instanceId) ?? {};
    if (meta.streamSeq !== undefined) {
      current.streamSeq = Math.max(current.streamSeq ?? meta.streamSeq, meta.streamSeq);
    }
    if (meta.bufferGeneration !== undefined) current.bufferGeneration = meta.bufferGeneration;
    if (meta.cursorEpoch !== undefined) current.cursorEpoch = meta.cursorEpoch;
    if (meta.adapterGeneration !== undefined) current.adapterGeneration = meta.adapterGeneration;
    this.cursors.set(instanceId, current);
  }

  private updateFullCursor(
    instanceId: string,
    value: number | undefined,
    meta: MobileMessagesResumeDto['meta'] | undefined,
  ): void {
    if (!meta) {
      this.updateBufferIndex(instanceId, value);
      return;
    }
    const current = this.cursors.get(instanceId) ?? {};
    const sameGeneration =
      current.bufferGeneration !== undefined &&
      meta.bufferGeneration !== undefined &&
      current.bufferGeneration === meta.bufferGeneration &&
      !cursorEpochChanged(current.cursorEpoch, meta.cursorEpoch) &&
      (current.adapterGeneration === undefined ||
        meta.adapterGeneration === undefined ||
        current.adapterGeneration === meta.adapterGeneration);
    const next = { ...current };
    if (value !== undefined && value >= 0) {
      next.bufferIndex = sameGeneration
        ? Math.max(current.bufferIndex ?? value, value)
        : value;
    } else if (!sameGeneration) {
      delete next.bufferIndex;
    }
    if (meta.bufferGeneration !== undefined) next.bufferGeneration = meta.bufferGeneration;
    if (meta.cursorEpoch !== undefined) next.cursorEpoch = meta.cursorEpoch;
    if (meta.adapterGeneration !== undefined) next.adapterGeneration = meta.adapterGeneration;
    if (meta.streamSeq !== undefined) {
      next.streamSeq = sameGeneration
        ? Math.max(current.streamSeq ?? meta.streamSeq, meta.streamSeq)
        : meta.streamSeq;
    } else if (!sameGeneration) {
      delete next.streamSeq;
    }
    this.cursors.set(instanceId, next);
  }

  private async requestCompatibleFullTranscript(
    instanceId: string,
    request: () => Promise<FullTranscriptPayload>,
    isCurrent: () => boolean,
    transition?: {
      from: TranscriptCursorState | undefined;
      to: MobileMessagesResumeDto['meta'];
    },
  ): Promise<FullTranscriptPayload | null> {
    for (let attempt = 0; attempt < MAX_FULL_LOAD_ATTEMPTS; attempt += 1) {
      const candidate = await request();
      if (!isCurrent()) return null;
      const current = this.cursors.get(instanceId);
      const expected = transition && sameGeneration(current, transition.from)
        ? transition.to
        : current;
      if (!Array.isArray(candidate) && fullPayloadConflicts(expected, candidate.meta)) {
        if (attempt === MAX_FULL_LOAD_ATTEMPTS - 1) {
          throw new Error('The transcript changed repeatedly while loading. Try again.');
        }
        continue;
      }
      return candidate;
    }
    return null;
  }

  private isNewerThanWatermark(
    instanceId: string,
    message: MobileMessageDto,
    watermark: number | undefined,
    preserveUntracked: boolean,
  ): boolean {
    const revision = this.liveMessageStreamSeq.get(instanceId)?.get(message.id);
    if (revision === undefined) return preserveUntracked;
    return watermark === undefined || revision > watermark;
  }
}

function generationChanged<T>(previous: T | undefined, next: T | undefined): boolean {
  return previous !== undefined && next !== undefined && previous !== next;
}

function cursorEpochChanged(previous: string | undefined, next: string | undefined): boolean {
  return previous !== next;
}

function sameGeneration(
  left: TranscriptCursorState | undefined,
  right: TranscriptCursorState | undefined,
): boolean {
  return left?.bufferGeneration === right?.bufferGeneration &&
    left?.cursorEpoch === right?.cursorEpoch &&
    left?.adapterGeneration === right?.adapterGeneration;
}

function fullPayloadConflicts(
  cursor: TranscriptCursorState | undefined,
  meta: MobileMessagesResumeDto['meta'],
): boolean {
  if (!cursor) return false;
  return generationChanged(cursor?.bufferGeneration, meta.bufferGeneration) ||
    cursorEpochChanged(cursor?.cursorEpoch, meta.cursorEpoch) ||
    generationChanged(cursor?.adapterGeneration, meta.adapterGeneration);
}

function mergeMessages(
  base: MobileMessageDto[],
  additions: MobileMessageDto[],
): MobileMessageDto[] {
  const merged = [...base];
  for (const message of additions) {
    const identity = messageIdentity(message);
    const existing = merged.findIndex((item) => messageIdentity(item) === identity);
    const byId = existing >= 0 ? existing : merged.findIndex((item) => item.id === message.id);
    if (byId >= 0) merged[byId] = message;
    else merged.push(message);
  }
  return merged.sort((left, right) => {
    if (left.seq !== undefined && right.seq !== undefined) return left.seq - right.seq;
    return left.timestamp - right.timestamp;
  });
}

function messageIdentity(message: MobileMessageDto): string {
  return `${message.timestamp}\u0000${message.content}`;
}
