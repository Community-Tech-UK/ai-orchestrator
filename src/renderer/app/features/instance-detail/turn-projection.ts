/**
 * Per-turn projection of the raw transcript.
 *
 * The display pipeline (DisplayItemProcessor) turns messages into rows; it does
 * not know where one turn ends, and it drops the records that say whether a
 * tool call worked. This module reads the raw messages instead and answers, for
 * each turn: what did it do, how long did it take, did it end in a reply, was
 * it interrupted, and did an edit fail that nothing redid. It is a pure
 * function of the transcript, so it can be tested without a component, and the
 * output stream uses it without creating a second display processor.
 *
 * Where a turn starts:
 *  - a user message, whoever delivered it;
 *  - input Harness wrote itself (an `internalInput` system message), which
 *    makes the agent work even though the user never typed it;
 *  - a new provider turn id with no input of its own (a goal that carries on).
 * A message sent while the provider is still on the same turn id (a steer) does
 * not start a new turn: it joins the one already running.
 */

import { findEditFailureWarning, summariseTurn, type EditFailureWarning, type TurnSummary } from '../../../../shared/summarise-turn';
import { collectTurnToolEvents, type TurnToolEvent } from '../../../../shared/turn-tool-events';
import { turnStartKind } from '../../../../shared/turn-start';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { isProgressNoteMessage } from './progress-note';

export type TurnProjectionStartKind = 'user' | 'machine' | 'provider' | 'unknown';

export interface TurnProjectionOptions {
  /** Working folder, so absolute and relative spellings of one file compare equal. */
  cwd?: string;
  /**
   * True while the instance is still busy with the last turn. Leave it out when
   * the host cannot say (a chat, a history preview): the last turn then counts
   * as over once it ends in a reply.
   */
  lastTurnOpen?: boolean;
  /** How the instance itself says the last turn ended. */
  lastTurnOutcome?: 'completed' | 'interrupted' | 'cancelled' | 'failed';
}

export interface TurnProjection {
  /** Id of the message that started the turn; stable while the transcript grows. */
  key: string;
  /** Ids of every input message in the turn, in order; a steered turn has one per input. */
  inputKeys: readonly string[];
  startKind: TurnProjectionStartKind;
  /** False when the loaded transcript begins part-way through this turn. */
  complete: boolean;
  /** Range of the transcript this turn covers: `[startIndex, endIndex)`. */
  startIndex: number;
  endIndex: number;
  startedAt: number;
  /** Time of the last piece of work (reply, tool call, error), not of a trailing notice. */
  activityEndedAt: number;
  firstToolAt?: number;
  settled: boolean;
  hasFinalReply: boolean;
  interrupted: boolean;
  providerTurnId?: string;
  toolEvents: readonly TurnToolEvent[];
  summary: TurnSummary | null;
  warning: EditFailureWarning | null;
}

export interface TurnProjectionResult {
  turns: readonly TurnProjection[];
  /** Message id to index in `turns`, for placing display rows. */
  turnOfMessage: ReadonlyMap<string, number>;
}

interface Segment {
  start: number;
  end: number;
  kind: TurnProjectionStartKind;
  turnId?: string;
}

export function projectTurns(
  messages: readonly OutputMessage[],
  options: TurnProjectionOptions,
): TurnProjectionResult {
  const segments = splitIntoSegments(messages);
  const turnOfMessage = new Map<string, number>();
  segments.forEach((segment, index) => {
    for (let at = segment.start; at < segment.end; at += 1) turnOfMessage.set(messages[at].id, index);
  });

  // Tool calls are read across the whole transcript, then handed to the turn
  // that opened them, so a result that lands after the next input still
  // settles the call it belongs to instead of appearing as a stray call.
  const eventsByTurn = segments.map(() => [] as TurnToolEvent[]);
  for (const event of collectTurnToolEvents(messages, { cwd: options.cwd })) {
    const turn = turnOfMessage.get(event.startMessageId);
    if (turn !== undefined) eventsByTurn[turn].push(event);
  }

  const turns = segments.map((segment, index) =>
    projectSegment(messages, segment, eventsByTurn[index], index === segments.length - 1, options));
  return { turns, turnOfMessage };
}

function splitIntoSegments(messages: readonly OutputMessage[]): Segment[] {
  const segments: Segment[] = [];
  messages.forEach((message, index) => {
    const start = turnStartKind(message);
    if (start) {
      segments.push({ start: index, end: index + 1, kind: start });
      return;
    }
    const current = segments[segments.length - 1];
    if (!current) {
      segments.push({ start: index, end: index + 1, kind: 'unknown', turnId: providerTurnId(message) });
      return;
    }
    const turnId = providerTurnId(message);
    if (turnId && current.turnId === undefined) {
      const previous = segments[segments.length - 2];
      if (previous && previous.turnId === turnId && (current.kind === 'user' || current.kind === 'machine')) {
        // The provider is still on the previous turn: this input was a steer.
        previous.end = index + 1;
        segments.pop();
        return;
      }
      current.turnId = turnId;
    } else if (turnId && current.turnId !== turnId) {
      segments.push({ start: index, end: index + 1, kind: 'provider', turnId });
      return;
    }
    current.end = index + 1;
  });
  return segments;
}

function projectSegment(
  messages: readonly OutputMessage[],
  segment: Segment,
  toolEvents: readonly TurnToolEvent[],
  isLast: boolean,
  options: TurnProjectionOptions,
): TurnProjection {
  const first = messages[segment.start];
  const complete = segment.kind !== 'unknown';
  const hasFinalReply = endsInReply(messages, segment);
  const settled = !(isLast && (options.lastTurnOpen ?? !hasFinalReply));
  const interrupted = hasInterruptMarker(messages, segment)
    || (isLast && (options.lastTurnOutcome === 'interrupted' || options.lastTurnOutcome === 'cancelled'));

  let activityEndedAt = first.timestamp;
  for (let at = segment.start; at < segment.end; at += 1) {
    const message = messages[at];
    if (isActivity(message)) activityEndedAt = Math.max(activityEndedAt, message.timestamp);
  }

  const reportable = complete && settled;
  const firstToolAt = toolEvents.length > 0 ? Math.min(...toolEvents.map((event) => event.startedAt)) : undefined;
  const inputKeys: string[] = [];
  for (let at = segment.start; at < segment.end; at += 1) {
    if (turnStartKind(messages[at])) inputKeys.push(messages[at].id);
  }
  return {
    key: first.id,
    inputKeys,
    startKind: segment.kind,
    complete,
    startIndex: segment.start,
    endIndex: segment.end,
    startedAt: first.timestamp,
    activityEndedAt,
    ...(firstToolAt !== undefined ? { firstToolAt } : {}),
    settled,
    hasFinalReply,
    interrupted,
    ...(segment.turnId ? { providerTurnId: segment.turnId } : {}),
    toolEvents,
    summary: reportable ? summariseTurn(toolEvents, activityEndedAt - first.timestamp) : null,
    warning: reportable
      ? findEditFailureWarning(toolEvents, { hasFinalReply, interrupted, cwd: options.cwd })
      : null,
  };
}

function providerTurnId(message: OutputMessage): string | undefined {
  const turnId = message.metadata?.['turnId'];
  return typeof turnId === 'string' && turnId ? turnId : undefined;
}

/** Replies, tool traffic and errors are work; system notices and the input itself are not. */
function isActivity(message: OutputMessage): boolean {
  return message.type === 'assistant' || message.type === 'tool_use'
    || message.type === 'tool_result' || message.type === 'error';
}

/**
 * True when the last thing the turn did was write an answer: the last message
 * that carries content is an assistant reply that is finished and is not a
 * progress note. Notices, outcome records and thinking-only messages are skipped.
 */
function endsInReply(messages: readonly OutputMessage[], segment: Segment): boolean {
  for (let at = segment.end - 1; at >= segment.start; at -= 1) {
    const message = messages[at];
    if (message.type === 'system' || message.type === 'tool_outcome') continue;
    if (message.type !== 'assistant') return false;
    if (message.metadata?.['streaming'] === true) return false;
    if (!message.content?.trim()) continue;
    return !isProgressNoteMessage(message);
  }
  return false;
}

/** An interrupt notice recorded in the turn, as boundary metadata or the older plain notice. */
function hasInterruptMarker(messages: readonly OutputMessage[], segment: Segment): boolean {
  for (let at = segment.start; at < segment.end; at += 1) {
    const message = messages[at];
    if (message.type !== 'system') continue;
    if (message.metadata?.['kind'] === 'interrupt-boundary') return true;
    if (message.content?.trimStart().startsWith('Interrupted —')) return true;
  }
  return false;
}
