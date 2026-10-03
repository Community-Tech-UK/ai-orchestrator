import { StdinWriteProcessExitError } from './child-stdin-write';

export const ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE = 'ACP prompt turn was cancelled by the client.';
const inputWriteFailures = new WeakSet<Error>();

/** Preserve the native exit diagnostic while rejecting an unacknowledged input. */
export function normalizeAcpInputWriteError(error: unknown): Error {
  if (error instanceof StdinWriteProcessExitError) {
    return Object.assign(new Error(`ACP agent exited (${error.exitCode ?? 'null'}${error.signal ? `/${error.signal}` : ''}).`), { code: 'EPIPE' });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function markAcpInputWriteFailure(error: Error): void {
  inputWriteFailures.add(error);
}

/** Native input-write rejection is distinct from a delivered prompt's failed turn. */
export function isAcpInputWriteFailure(error: Error): boolean {
  return inputWriteFailures.has(error);
}

export function isAcpPromptRequestTimeout(error: Error): boolean {
  return /^ACP session\/prompt request timed out after \d+ms(?: without a session\/update)? \(id=.+\)\./.test(error.message);
}

export function isAcpPromptCancelledByClient(error: Error): boolean {
  return error.message === ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE;
}

export function isAcpActiveTurnCollision(error: Error): boolean {
  return error.message.startsWith('Cannot send message: the previous turn is still running.');
}

/** Excludes caller-driven terminate(); the process exit handler owns crash recovery. */
export function isAcpAgentExitRejection(error: Error): boolean {
  return error.message.startsWith('ACP agent exited (');
}
