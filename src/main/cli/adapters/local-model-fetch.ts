export async function withLocalModelFetchResponse<T>(
  url: string,
  init: RequestInit,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
  timeoutMessage: string,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (!isAbortSignalRealmError(error)) throw error;
      response = await fetchWithoutSignal(url, init, controller.signal);
    }
    return await consume(response, controller.signal);
  } catch (error) {
    if (timedOut) throw new Error(timeoutMessage);
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function fetchWithoutSignal(
  url: string,
  init: RequestInit,
  cancellationSignal: AbortSignal,
): Promise<Response> {
  const fallbackInit: RequestInit = { ...init };
  delete fallbackInit.signal;
  if (cancellationSignal.aborted) return Promise.reject(cancellationSignal.reason);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const settle = (result: { response: Response } | { error: unknown }): void => {
      if (settled) {
        if ('response' in result) {
          void result.response.body?.cancel().catch(() => undefined);
        }
        return;
      }
      settled = true;
      cancellationSignal.removeEventListener('abort', onAbort);
      if ('response' in result) resolve(result.response);
      else reject(result.error);
    };
    const onAbort = (): void => settle({ error: cancellationSignal.reason });
    cancellationSignal.addEventListener('abort', onAbort, { once: true });
    void fetch(url, fallbackInit).then(
      (response) => settle({ response }),
      (error: unknown) => settle({ error }),
    );
  });
}

function isAbortSignalRealmError(error: unknown): boolean {
  return error instanceof TypeError
    && error.message.includes('Expected signal')
    && error.message.includes('AbortSignal');
}
