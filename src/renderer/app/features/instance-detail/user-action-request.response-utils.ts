import type { WritableSignal } from '@angular/core';

export function setResponseError(
  errorsSignal: WritableSignal<Map<string, string>>,
  requestId: string,
  message: string,
): void {
  const errors = new Map(errorsSignal());
  errors.set(requestId, message);
  errorsSignal.set(errors);
}

export function clearResponseError(
  errorsSignal: WritableSignal<Map<string, string>>,
  requestId: string,
): void {
  const errors = new Map(errorsSignal());
  if (errors.delete(requestId)) {
    errorsSignal.set(errors);
  }
}

export function responseErrorMessage(result: unknown, fallback: string): string {
  const message = (result as { error?: { message?: unknown } })?.error?.message;
  return typeof message === 'string' && message.trim() ? message : fallback;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

/** Sends a typed note as the agent's next message; resolves to why it failed, or null when it went. */
export async function sendNoteToAgent(
  ipc: { sendInput(instanceId: string, text: string): Promise<unknown> },
  instanceId: string,
  note: string,
): Promise<string | null> {
  try {
    const sent = await ipc.sendInput(instanceId, note);
    return (sent as { success?: boolean }).success ? null : responseErrorMessage(sent, 'Could not send your note.');
  } catch (error) {
    return errorMessage(error, 'Could not send your note.');
  }
}
