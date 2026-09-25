import { randomUUID } from 'node:crypto';
import type { OutputMessage } from '../../shared/types/instance.types';

interface CursorState {
  nextStreamSeq: number;
  offset: number;
  bufferGeneration: number;
  identities: string[];
  timestamps: number[];
}

export interface MobileGatewayBufferView {
  cursorEpoch: string;
  offset: number;
  bufferGeneration: number;
  nextStreamSeq: number;
}

export interface MobileGatewayLiveCursor extends MobileGatewayBufferView {
  streamSeq: number;
  bufferIndex: number;
  message: OutputMessage;
}

/**
 * Keeps the WebSocket output sequence independent from provider lifecycle
 * events and maps the rolling output buffer onto an absolute cursor space.
 */
export class MobileGatewayStreamCursor {
  private readonly states = new Map<string, CursorState>();
  private cursorEpoch = randomUUID();

  inspect(instanceId: string, buffer: OutputMessage[]): MobileGatewayBufferView {
    const state = this.sync(instanceId, buffer);
    return {
      cursorEpoch: this.cursorEpoch,
      offset: state.offset,
      bufferGeneration: state.bufferGeneration,
      nextStreamSeq: state.nextStreamSeq,
    };
  }

  recordLive(
    instanceId: string,
    buffer: OutputMessage[],
    candidate: OutputMessage,
  ): MobileGatewayLiveCursor {
    const state = this.sync(instanceId, buffer);
    const localIndex = this.findMessageIndex(buffer, candidate);
    const message = localIndex >= 0 ? buffer[localIndex] : candidate;
    const bufferIndex = state.offset + (localIndex >= 0 ? localIndex : buffer.length);
    const streamSeq = state.nextStreamSeq;
    state.nextStreamSeq += 1;
    return {
      cursorEpoch: this.cursorEpoch,
      offset: state.offset,
      bufferGeneration: state.bufferGeneration,
      nextStreamSeq: state.nextStreamSeq,
      streamSeq,
      bufferIndex,
      message,
    };
  }

  drop(instanceId: string): void {
    this.states.delete(instanceId);
  }

  clear(): void {
    this.states.clear();
    this.cursorEpoch = randomUUID();
  }

  private sync(instanceId: string, buffer: OutputMessage[]): CursorState {
    const identities = buffer.map(messageIdentity);
    const timestamps = buffer.map((message) => message.timestamp);
    let state = this.states.get(instanceId);
    if (!state) {
      state = {
        nextStreamSeq: 0,
        offset: 0,
        bufferGeneration: 0,
        identities,
        timestamps,
      };
      this.states.set(instanceId, state);
      return state;
    }

    if (sameArray(state.identities, identities)) return state;

    const overlap = suffixPrefixOverlap(state.identities, identities);
    if (overlap > 0) {
      state.offset += state.identities.length - overlap;
    } else if (isPrefix(state.timestamps, timestamps)) {
      // Streaming updates replace content in-place and can be followed by new
      // messages before the next client inspection. A stable timestamp prefix
      // means this is ordinary growth, not a trim/reset, even though one of the
      // retained timestamp+content identities changed.
    } else if (state.identities.length > 0) {
      state.offset = 0;
      state.bufferGeneration += 1;
    }

    state.identities = identities;
    state.timestamps = timestamps;
    return state;
  }

  private findMessageIndex(buffer: OutputMessage[], candidate: OutputMessage): number {
    const identity = messageIdentity(candidate);
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (messageIdentity(buffer[index]) === identity) return index;
    }
    // The raw provider bridge and the canonical output event can carry the same
    // streaming message with different timestamps/content. Resolve that
    // representation mismatch by stable ID only for this live lookup; trim
    // continuity above deliberately remains timestamp+content based.
    for (let index = buffer.length - 1; index >= 0; index -= 1) {
      if (buffer[index].id === candidate.id) return index;
    }
    return -1;
  }
}

function messageIdentity(message: OutputMessage): string {
  return `${message.timestamp}\u0000${message.content}`;
}

function sameArray<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPrefix<T>(prefix: T[], values: T[]): boolean {
  return prefix.length <= values.length && prefix.every((value, index) => value === values[index]);
}

function suffixPrefixOverlap(previous: string[], current: string[]): number {
  const maximum = Math.min(previous.length, current.length);
  for (let size = maximum; size > 0; size -= 1) {
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      if (previous[previous.length - size + index] !== current[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}
