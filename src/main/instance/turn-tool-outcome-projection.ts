/** Keep hidden outcomes on their existing call, without exposing another transcript row. */
import type { OutputMessage } from '../../shared/types/instance.types';
import { redactSecrets } from '../security/secret-detector';

export function safeToolOutcome(message: OutputMessage): OutputMessage {
  const content = redactSecrets(message.content)
    .replace(/\b(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|secret|password|token)\s*[=:]\s*)[^\s"']+/gi, '$1[REDACTED]')
    .slice(0, 2_000);
  return { ...message, content };
}

export function projectToolOutcome(messages: readonly OutputMessage[], outcome: OutputMessage): OutputMessage | undefined {
  const metadata = outcome.metadata;
  const id = metadata?.['tool_use_id'];
  if (typeof id !== 'string' || typeof metadata?.['is_error'] !== 'boolean') return;
  const startIndex = lastMatchingIndex(messages, message => message.type === 'tool_use'
    && (message.metadata?.['id'] === id || message.metadata?.['toolCallId'] === id)
    && (metadata['adapterGeneration'] === undefined || message.metadata?.['adapterGeneration'] === metadata['adapterGeneration'])
    && (metadata['turnId'] === undefined || message.metadata?.['turnId'] === metadata['turnId']));
  if (startIndex < 0) return;
  const start = messages[startIndex];
  const safe = safeToolOutcome(outcome);
  return { ...start, metadata: { ...start.metadata, streaming: false,
    is_error: metadata['is_error'], output: safe.content,
    ...Object.fromEntries(['exitCode', 'isCheck', 'checkFailed'].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])),
  } };
}

/** Archive/load boundary: fold outcomes into calls before dropping the hidden records. */
export function projectArchivedToolOutcomes(messages: readonly OutputMessage[]): OutputMessage[] {
  const projected: OutputMessage[] = [];
  for (const message of messages) {
    if (message.type !== 'tool_outcome') { projected.push(message); continue; }
    const call = projectToolOutcome(projected, message);
    if (call) {
      const index = lastMatchingIndex(projected, candidate => candidate.id === call.id);
      projected[index] = call;
    }
  }
  return projected;
}

function lastMatchingIndex<T>(items: readonly T[], matches: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (matches(items[index])) return index;
  }
  return -1;
}
