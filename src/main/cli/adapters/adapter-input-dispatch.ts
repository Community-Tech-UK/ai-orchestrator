import type { AdapterInputDispatch } from './base-cli-adapter.types';

export function assertAdapterInputCurrent(dispatch?: AdapterInputDispatch, nativeOwner = false): void {
  dispatch?.assertCurrent?.();
  if (!dispatch?.signal?.aborted && !(dispatch?.autoContinuation && nativeOwner)) return;
  const error = new Error('Adapter input became ineligible before provider dispatch');
  error.name = 'AbortError';
  throw error;
}

/** One logical send may retry native RPCs, but commits its admission only once. */
export function createAdapterInputDispatch(dispatch?: AdapterInputDispatch): AdapterInputDispatch | undefined {
  if (!dispatch) return undefined;
  let committed = false;
  return { ...dispatch, beforeProviderDispatch: () => {
    assertAdapterInputCurrent(dispatch);
    if (committed) return;
    dispatch.beforeProviderDispatch?.();
    committed = true;
  } };
}
