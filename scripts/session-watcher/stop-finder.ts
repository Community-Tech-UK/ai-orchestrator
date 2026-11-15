import type { OutputMessage } from '../../src/shared/types/instance.types';
import { isBareGoAhead, stripInjected } from './message-classify';
import type { StopRef, StopSource } from './types';

function startsTurn(message: OutputMessage): boolean {
  if (message.type === 'user') return true;
  return message.type === 'system' && !!message.metadata?.internalInput;
}

export interface FoundStop {
  stopIndex: number;
  stoppedAt: number;
  final: boolean;
  next: StopRef['next'];
}

/**
 * Finds the stops in one conversation: the last assistant message with text before
 * the next message that starts a turn, when that next message is typed by a person;
 * plus the final assistant text of the conversation when no turn starter follows it.
 * Rows that are not turn starters (tool rows, errors, plain system rows) are
 * skipped when looking for the next turn.
 */
export function findStops(messages: readonly OutputMessage[]): FoundStop[] {
  const stops: FoundStop[] = [];
  let candidate = -1; // index of the latest assistant message with text
  const consider = (nextIndex: number): void => {
    if (candidate < 0) return;
    const stopMessage = messages[candidate];
    if (nextIndex < 0) {
      stops.push({ stopIndex: candidate, stoppedAt: stopMessage.timestamp, final: true, next: { kind: 'none', chars: 0, bareGoAhead: false, gapMs: null } });
      return;
    }
    const next = messages[nextIndex];
    if (next.type !== 'user' || next.metadata?.inputOrigin?.kind !== 'person') return;
    const typedAt = next.metadata.inputOrigin.typedAt;
    const at = Number.isFinite(typedAt) ? typedAt : next.timestamp;
    stops.push({
      stopIndex: candidate,
      stoppedAt: stopMessage.timestamp,
      final: false,
      next: { kind: 'person', chars: stripInjected(next.content).length, bareGoAhead: isBareGoAhead(next.content), gapMs: Math.max(0, at - stopMessage.timestamp) },
    });
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.type === 'assistant') {
      if (message.content.trim()) candidate = index;
    } else if (startsTurn(message)) {
      consider(index);
      candidate = -1;
    }
    // tool_use, tool_result, tool_outcome, error and plain system rows never start a turn: skipped.
  }
  consider(-1);
  return stops;
}

export function toStopRef(found: FoundStop, base: { id: string; source: StopSource; file: string; provider: string }): StopRef {
  return {
    id: `${base.id}:${found.stopIndex}`, source: base.source, file: base.file, stopIndex: found.stopIndex,
    provider: base.provider, stoppedAt: found.stoppedAt, final: found.final, next: found.next,
  };
}
