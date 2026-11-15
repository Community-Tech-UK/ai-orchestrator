import type { OutputMessage } from '../../shared/types/instance.types';
import type { TodoStatus } from '../../shared/types/todo.types';
import { extractTodoToolItems } from '../instance/todo-tool-parser';

/** Metadata key on the message sent by the "Yes, go ahead" button; its value holds the question answered. */
export const WATCHER_APPROVAL_METADATA_KEY = 'sessionWatcherApproval';
export const WATCHER_INTERNAL_SOURCE = 'session-watcher';

const FIRST_PERSON_MESSAGE_CHARS = 6_000;
const LATER_PERSON_MESSAGE_CHARS = 2_000;
const PERSON_MESSAGES_BUDGET_CHARS = 40_000;
const EARLIER_REPLY_CHARS = 1_500;
const EARLIER_REPLY_COUNT = 2;
const FINAL_REPLY_HEAD_CHARS = 1_000;
const FINAL_REPLY_TAIL_CHARS = 6_000;
const OPEN_TASK_LIMIT = 30;
const OPEN_TASK_CHARS = 200;
const ATTACHMENT_NAME_LIMIT = 10;

export interface WatcherBriefPersonMessage {
  /** Bounded text shown to the judge. */
  text: string;
  attachments: string[];
  /** True for a "Yes, go ahead" click: the user's answer, but not words they typed. */
  clicked: boolean;
}

export interface WatcherBriefTaskList {
  counts: Record<TodoStatus, number>;
  open: string[];
}

export interface WatcherBrief {
  personMessages: WatcherBriefPersonMessage[];
  /** Person messages left out of `personMessages` to stay inside the budget. */
  omittedPersonMessages: number;
  /** Every typed message in full, for the code's quote check. Never includes clicks. */
  personTexts: string[];
  automaticMessagesSincePerson: number;
  watcherRepliesSincePerson: number;
  /** False only when a watcher reply was sent and no tool has run since. */
  toolRanSinceWatcherReply: boolean;
  taskList: WatcherBriefTaskList | null;
  earlierReplies: string[];
  /** Bounded final reply shown to the judge. */
  finalReply: string;
  finalReplyFull: string;
}

/** Keeps the start and the end of a long text; the middle is replaced by a count. */
export function clipMiddle(text: string, headChars: number, tailChars: number): string {
  if (text.length <= headChars + tailChars) return text;
  const omitted = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n[... ${omitted} characters left out ...]\n${text.slice(text.length - tailChars)}`;
}

/** Retained prompts first, then the live buffer, without repeating a message both hold. */
export function mergeWatcherMessages(
  retainedPrompts: readonly OutputMessage[] | undefined,
  outputBuffer: readonly OutputMessage[],
): OutputMessage[] {
  const bufferIds = new Set<string>(outputBuffer.map((message) => message.id));
  const kept = (retainedPrompts ?? []).filter((message) => !bufferIds.has(message.id));
  return [...kept, ...outputBuffer].sort((a, b) => a.timestamp - b.timestamp);
}

function isTypedByPerson(message: OutputMessage): boolean {
  return message.type === 'user' && message.metadata?.inputOrigin?.kind === 'person';
}

function approvalQuestion(message: OutputMessage): string | null {
  if (message.type !== 'user') return null;
  const marker = message.metadata?.[WATCHER_APPROVAL_METADATA_KEY];
  if (!marker || typeof marker !== 'object') return null;
  const question = (marker as Record<string, unknown>)['question'];
  return typeof question === 'string' ? question : '';
}

function internalSource(message: OutputMessage): string | null {
  return message.metadata?.internalInput?.source ?? null;
}

/** Any message that starts a turn: the user's, another session's, or one Harness wrote. */
function startsTurn(message: OutputMessage): boolean {
  return message.type === 'user' || internalSource(message) !== null;
}

function attachmentNames(message: OutputMessage): string[] {
  return (message.attachments ?? []).slice(0, ATTACHMENT_NAME_LIMIT).map((file) => file.name.slice(0, 120));
}

function boundPersonMessages(all: readonly WatcherBriefPersonMessage[]): { kept: WatcherBriefPersonMessage[]; omitted: number } {
  if (all.length === 0) return { kept: [], omitted: 0 };
  const first = all[0];
  let used = first.text.length;
  const later: WatcherBriefPersonMessage[] = [];
  for (let index = all.length - 1; index >= 1; index -= 1) {
    const candidate = all[index];
    if (used + candidate.text.length > PERSON_MESSAGES_BUDGET_CHARS) break;
    used += candidate.text.length;
    later.unshift(candidate);
  }
  return { kept: [first, ...later], omitted: all.length - 1 - later.length };
}

function latestTaskList(messages: readonly OutputMessage[]): WatcherBriefTaskList | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const items = extractTodoToolItems(messages[index]);
    if (!items) continue;
    const counts: Record<TodoStatus, number> = { pending: 0, in_progress: 0, completed: 0, cancelled: 0 };
    for (const item of items) counts[item.status] += 1;
    const open = items
      .filter((item) => item.status === 'pending' || item.status === 'in_progress')
      .slice(0, OPEN_TASK_LIMIT)
      .map((item) => item.content.slice(0, OPEN_TASK_CHARS));
    return { counts, open };
  }
  return null;
}

/**
 * Everything the judge is shown about one stop, built from the conversation
 * alone. Pure, so the offline replay and the running app test the same thing.
 * `messages` is oldest first (see {@link mergeWatcherMessages}).
 */
export function buildWatcherBrief(messages: readonly OutputMessage[]): WatcherBrief {
  const person: WatcherBriefPersonMessage[] = [];
  const personTexts: string[] = [];
  let lastPersonIndex = -1;
  let lastWatcherReplyIndex = -1;
  let finalIndex = -1;

  messages.forEach((message, index) => {
    if (message.type === 'assistant' && message.content.trim()) finalIndex = index;
    const question = approvalQuestion(message);
    const typed = isTypedByPerson(message);
    if (typed || question !== null) {
      lastPersonIndex = index;
      const limit = person.length === 0 ? FIRST_PERSON_MESSAGE_CHARS : LATER_PERSON_MESSAGE_CHARS;
      // A click is recorded with the question it answered, so a later stop knows what was approved.
      const text = typed ? message.content : `Yes, go ahead. (The user clicked this in answer to the agent's question, quoted here in the agent's words: ${question || 'not recorded'})`;
      person.push({ text: clipMiddle(text, limit, 0), attachments: attachmentNames(message), clicked: !typed });
      if (typed) personTexts.push(message.content);
    }
    if (internalSource(message) === WATCHER_INTERNAL_SOURCE) lastWatcherReplyIndex = index;
  });

  let automaticMessagesSincePerson = 0;
  let watcherRepliesSincePerson = 0;
  for (let index = lastPersonIndex + 1; index < messages.length; index += 1) {
    const source = internalSource(messages[index]);
    if (source === null) continue;
    automaticMessagesSincePerson += 1;
    if (source === WATCHER_INTERNAL_SOURCE) watcherRepliesSincePerson += 1;
  }
  const toolRanSinceWatcherReply = lastWatcherReplyIndex < 0
    || messages.slice(lastWatcherReplyIndex + 1).some((message) => message.type === 'tool_use');

  // The reply that closed each earlier turn: the last assistant text before the next turn began.
  const turnEndings: string[] = [];
  let pending: string | null = null;
  for (let index = 0; index < finalIndex; index += 1) {
    const message = messages[index];
    if (message.type === 'assistant' && message.content.trim()) pending = message.content;
    else if (startsTurn(message) && pending !== null) { turnEndings.push(pending); pending = null; }
  }

  const finalReplyFull = finalIndex >= 0 ? messages[finalIndex].content : '';
  const { kept, omitted } = boundPersonMessages(person);
  return {
    personMessages: kept,
    omittedPersonMessages: omitted,
    personTexts,
    automaticMessagesSincePerson,
    watcherRepliesSincePerson,
    toolRanSinceWatcherReply,
    taskList: latestTaskList(messages),
    earlierReplies: turnEndings.slice(-EARLIER_REPLY_COUNT).map((reply) => clipMiddle(reply, 0, EARLIER_REPLY_CHARS)),
    finalReply: clipMiddle(finalReplyFull, FINAL_REPLY_HEAD_CHARS, FINAL_REPLY_TAIL_CHARS),
    finalReplyFull,
  };
}
