import type { WritableSignal } from '@angular/core';

export function shouldClearInputRequiredForStatus(status: string | undefined): boolean {
  return status === 'terminated'
    || status === 'failed'
    || status === 'error'
    || status === 'cancelled'
    || status === 'hibernated'
    || status === 'initializing'
    || status === 'respawning'
    || status === 'interrupting'
    || status === 'cancelling'
    || status === 'interrupt-escalating'
    || status === 'waking';
}

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
