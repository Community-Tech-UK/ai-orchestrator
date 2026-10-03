export interface CodexExecInputWritePhase {
  accepted: boolean;
  cancelled: boolean;
}

const inputFailures = new WeakMap<Error, boolean>();
const unacceptedFailures = new WeakSet<Error>();
const clientCancellations = new WeakSet<Error>();

/** Keep transport failure identity without exposing a new provider error field. */
export function markCodexExecInputFailure(error: Error, accepted = false): Error {
  inputFailures.set(error, accepted);
  return error;
}

export function isCodexExecInputFailure(error: unknown): boolean {
  return error instanceof Error && inputFailures.has(error);
}

export function isUnacceptedCodexExecInputFailure(error: unknown): boolean {
  return error instanceof Error && (inputFailures.get(error) === false || unacceptedFailures.has(error));
}

export function noteUnacceptedCodexExecInput(error: Error): void {
  unacceptedFailures.add(error);
}

export function cancelCodexExecInputFailure(error: Error, accepted = false): Error {
  const cancelled = new Error(accepted ? 'Codex exec turn was interrupted'
    : 'Codex exec input was interrupted before its native write completed', { cause: error });
  cancelled.name = 'AbortError';
  clientCancellations.add(cancelled);
  return markCodexExecInputFailure(cancelled, accepted);
}

export function isCancelledCodexExecInput(error: Error): boolean {
  return clientCancellations.has(error);
}
