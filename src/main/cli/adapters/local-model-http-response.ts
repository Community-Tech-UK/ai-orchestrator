import { LocalModelToolResponseError } from './local-model-chat-adapter';

export const MAX_LOCAL_MODEL_JSON_RESPONSE_BYTES = 1024 * 1024;
export const MAX_LOCAL_MODEL_ERROR_RESPONSE_BYTES = 16 * 1024;

export type LocalModelStreamReadResult =
  | { done: false; value: Uint8Array }
  | { done: true; value?: undefined };

export interface LocalModelResponseReader {
  read(): Promise<LocalModelStreamReadResult>;
  cancel(): Promise<void>;
  release(): void;
}

export function openLocalModelResponseReader(
  response: Response,
  signal?: AbortSignal,
): LocalModelResponseReader {
  if (!response.body) throw new Error('Local-model response did not include a body');
  const reader = response.body.getReader();
  const abort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return {
    read: async () => {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      return result.done
        ? { done: true }
        : { done: false, value: result.value };
    },
    cancel: async () => { await reader.cancel().catch(() => undefined); },
    release: () => {
      signal?.removeEventListener('abort', abort);
      try { reader.releaseLock(); } catch { /* The stream may still be settling after cancellation. */ }
    },
  };
}

export async function readLocalModelResponseText(
  response: Response,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
  truncate = false,
): Promise<string> {
  if (signal?.aborted) {
    await response.body?.cancel(signal.reason).catch(() => undefined);
    throw abortReason(signal);
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes && !truncate) {
    await response.body?.cancel().catch(() => undefined);
    throw new LocalModelToolResponseError(`${label} exceeded ${maxBytes} bytes`);
  }
  if (!response.body) return '';

  const reader = openLocalModelResponseReader(response, signal);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const read = await reader.read();
      if (read.done) break;
      const remaining = maxBytes - bytes;
      if (read.value.byteLength > remaining) {
        if (truncate && remaining > 0) chunks.push(read.value.slice(0, remaining));
        await reader.cancel();
        if (truncate) return `${decode(chunks)}…[truncated]`;
        throw new LocalModelToolResponseError(`${label} exceeded ${maxBytes} bytes`);
      }
      chunks.push(read.value);
      bytes += read.value.byteLength;
    }
    return decode(chunks);
  } finally {
    reader.release();
  }
}

export async function readLocalModelErrorText(
  response: Response,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await readLocalModelResponseText(
      response,
      MAX_LOCAL_MODEL_ERROR_RESPONSE_BYTES,
      'Local-model error response',
      signal,
      true,
    );
  } catch {
    if (signal?.aborted) throw abortReason(signal);
    return '';
  }
}

function decode(chunks: readonly Uint8Array[]): string {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Local-model response cancelled');
}
