export interface MobileLoadState {
  status: 'idle' | 'loading' | 'loaded' | 'error';
  error: string | null;
}
export const IDLE_LOAD: MobileLoadState = { status: 'idle', error: null };
export const LOADING: MobileLoadState = { status: 'loading', error: null };
export const LOADED: MobileLoadState = { status: 'loaded', error: null };
export const MOBILE_REQUEST_TIMEOUT_MS = 15000;

/** Bound both the response and body read without retrying a command. */
export async function withRequestDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The request timed out; its result is not confirmed. Check the session before trying again.'));
    }, MOBILE_REQUEST_TIMEOUT_MS);
  });
  try { return await Promise.race([operation(controller.signal), deadline]); }
  finally { clearTimeout(timer); }
}

export function failedLoad(error: unknown): MobileLoadState {
  return { status: 'error', error: error instanceof Error ? error.message : 'This host could not load the content. Try again.' };
}

export function friendlyRequestError(error: string | undefined, status: number): string {
  if (error && !/^[A-Z_\s-]+$/.test(error)) return error;
  if (status === 404) return 'This item is no longer available on the host. Refresh and try again.';
  if (status === 409) return 'The session changed while this action was pending. Refresh to see its current state.';
  if (status === 429) return 'The host is handling too many requests. Wait a moment and try again.';
  return 'The host could not complete this action. Check its current state before trying again.';
}
