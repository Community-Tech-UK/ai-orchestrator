import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { AcpHistoryReplay } from '../cli/adapters/acp-session-replay';
import { reconcileAcpHistoryReplay } from './acp-history-reconciliation';
import { redactRecoveryOutputMessage } from './instance-recovery-redaction';
import { mergeRetainedPrompts } from './prompt-retention';
import type { EventEmitter } from 'node:events';

export function bindInstanceAcpHistoryReplay(adapter: Pick<EventEmitter, 'on'> & { getSessionId(): string | null }, options: {
  isStale: () => boolean;
  getInstance: () => Instance | undefined;
  limit: () => number;
  markIncomplete: () => void;
  storeOverflow: (messages: OutputMessage[]) => void;
  publish: (messages: OutputMessage[]) => void;
}): void {
  adapter.on('history_replay', (history: AcpHistoryReplay) => {
    if (options.isStale() || history.sessionId !== adapter.getSessionId()) return;
    const instance = options.getInstance();
    if (instance) applyInstanceAcpHistoryReplay(instance, history, { ...options, limit: options.limit() });
  });
}

/** Synchronous validation precedes all publication; a refusal rejects startup. */
export function applyInstanceAcpHistoryReplay(instance: Instance, history: AcpHistoryReplay, options: {
  limit: number;
  markIncomplete: () => void;
  storeOverflow: (messages: OutputMessage[]) => void;
  publish: (messages: OutputMessage[]) => void;
}): void {
  if (instance.provider !== 'opencode') return;
  const replay = history.messages.map((message) => redactRecoveryOutputMessage(instance, message));
  const merged = reconcileAcpHistoryReplay(instance.outputBuffer, replay);
  const overflow = merged.slice(0, Math.max(0, merged.length - options.limit));
  options.markIncomplete();
  if (overflow.length > 0) {
    instance.retainedPrompts = mergeRetainedPrompts(instance.retainedPrompts, overflow);
    options.storeOverflow(overflow);
  }
  instance.outputBuffer = merged.slice(-options.limit);
  options.publish([...instance.outputBuffer]);
}
