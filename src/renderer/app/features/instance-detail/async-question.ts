/**
 * Async user-input questions — Codex's `request_user_input_async` tool.
 *
 * The main process forwards each one as an assistant message with
 * `metadata.asyncUserInput` and the structured `metadata.questions`. Codex keeps
 * working after asking, so the answer is an ordinary user message, sent the way
 * the host's composer sends: for an instance session, at once when idle and
 * queued behind the running turn when busy.
 */

import type { OutputMessage } from '../../core/state/instance/instance.types';

/**
 * Where a transcript host sends answers. Hosts whose transcript id is not the
 * live instance id (chats key their transcript by chat id and send through the
 * chat service) supply this; plain instance transcripts leave it null and the
 * controls use the instance store directly.
 */
export interface AsyncAnswerTarget {
  /** The live instance behind the transcript, for status and queue evidence. */
  instanceId: string;
  /** Sends the reply the way the host's own composer would, without its drafts or attachments. */
  send(text: string): Promise<void>;
}

/**
 * The target for a chat transcript: status from the chat's live instance, the
 * reply sent through the chat service (no composer drafts or attachments), and
 * a failure reported through the host's own error display. Null until the chat
 * has a live instance, which keeps the controls hidden.
 */
export function chatAsyncAnswerTarget(
  chatId: string | undefined,
  instanceId: string | undefined,
  sendMessageTo: (chatId: string, text: string) => Promise<{ ok: true } | { ok: false; error: string }>,
  reportError: (error: string) => void,
): AsyncAnswerTarget | null {
  if (!chatId || !instanceId) return null;
  return {
    instanceId,
    send: async (text) => {
      const result = await sendMessageTo(chatId, text);
      if (!result.ok) reportError(result.error);
    },
  };
}

export interface AsyncQuestion {
  title: string;
  /** Suggested answers, recommended first. Empty means free text only. */
  options: string[];
}

export function isAsyncQuestionMessage(message: OutputMessage | undefined): boolean {
  return message?.type === 'assistant' && message.metadata?.['asyncUserInput'] === true;
}

/** Reads `metadata.questions`, dropping anything that is not a usable question. */
export function parseAsyncQuestions(message: OutputMessage): AsyncQuestion[] {
  const raw = message.metadata?.['questions'];
  if (!Array.isArray(raw)) return [];
  const questions: AsyncQuestion[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const title = (entry as { title?: unknown }).title;
    if (typeof title !== 'string' || !title.trim()) continue;
    const rawOptions = (entry as { options?: unknown }).options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter((option): option is string => typeof option === 'string' && option.trim() !== '')
      : [];
    questions.push({ title: title.trim(), options });
  }
  return questions;
}

export function asyncQuestionSubagent(message: OutputMessage): string | null {
  const label = message.metadata?.['subagentLabel'];
  return typeof label === 'string' && label ? label : null;
}

/**
 * Builds the reply text. Each answer is paired with its question so the model
 * can match them however much work it did in between; a subagent's question is
 * addressed to that subagent so the root session can relay it.
 */
export function formatAsyncAnswer(
  questions: readonly AsyncQuestion[],
  answers: readonly string[],
  subagentLabel: string | null = null,
): string {
  const lines = [subagentLabel
    ? `Answer for subagent ${subagentLabel}, please pass it on:`
    : questions.length === 1 ? 'Answer to your question:' : 'Answers to your questions:'];
  questions.forEach((question, index) => {
    lines.push('', `Q: ${question.title}`, `A: ${answers[index]?.trim() ?? ''}`);
  });
  return lines.join('\n');
}

/** True when `text` is a reply built by `formatAsyncAnswer` for exactly these questions. */
export function isAsyncAnswerTo(text: string, questions: readonly AsyncQuestion[]): boolean {
  return questions.length > 0 && questions.every((question) => text.includes(`\nQ: ${question.title}\nA: `));
}

function sameQuestions(a: readonly AsyncQuestion[], b: readonly AsyncQuestion[]): boolean {
  return a.length === b.length && a.every((question, index) => question.title === b[index].title);
}

/**
 * Where this question's reply stands, judged only from evidence: `'sent'` once
 * a later user message carries it, `'queued'` while it waits behind the running
 * turn, otherwise `null`. An unrelated follow-up does not count, so it cannot
 * hide a question that is still open. Codex can ask the same question twice, so
 * a reply only counts up to the next identical question, and a queued reply
 * belongs to the latest one.
 */
export function asyncAnswerDelivery(
  message: OutputMessage,
  questions: readonly AsyncQuestion[],
  transcript: readonly OutputMessage[],
  queuedMessages: readonly string[],
): 'sent' | 'queued' | null {
  const index = transcript.findIndex((entry) => entry.id === message.id);
  let end = transcript.length;
  for (let next = index + 1; index >= 0 && next < transcript.length; next++) {
    const entry = transcript[next];
    if (isAsyncQuestionMessage(entry) && sameQuestions(parseAsyncQuestions(entry), questions)) {
      end = next;
      break;
    }
  }
  if (index >= 0 && transcript.slice(index + 1, end)
    .some((entry) => entry.type === 'user' && isAsyncAnswerTo(entry.content, questions))) return 'sent';
  if (end < transcript.length) return null;
  return queuedMessages.some((queued) => isAsyncAnswerTo(queued, questions)) ? 'queued' : null;
}
