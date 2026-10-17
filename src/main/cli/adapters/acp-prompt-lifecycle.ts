import type { AdapterInputDispatch, InterruptResult, TurnInterruptCompletion } from './base-cli-adapter.types';
import { assertAdapterInputCurrent, createAdapterInputDispatch } from './adapter-input-dispatch';
import { ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE } from './acp-prompt-errors';

/** Capture before spawn or attachment awaits, even when the caller supplies no controls. */
export function createAcpLifecycleDispatch(dispatch: AdapterInputDispatch | undefined, currentEpoch: () => number): AdapterInputDispatch {
  const epoch = currentEpoch();
  return createAdapterInputDispatch({ ...dispatch, assertCurrent: () => {
    assertAdapterInputCurrent(dispatch);
    if (epoch !== currentEpoch()) throw Object.assign(new Error(ACP_PROMPT_CANCELLED_BY_CLIENT_MESSAGE), { name: 'AbortError' });
  } })!;
}

/** The caller's cancellation and the adapter process lifetime have separate cleanup owners. */
export function createAcpInputLifecycle(
  dispatch: AdapterInputDispatch | undefined,
  currentEpoch: () => number,
  clearWatchdog: () => void,
): { admission: AdapterInputDispatch; isCurrent: () => boolean; clearWatchdog: () => void } {
  const epoch = currentEpoch();
  const isCurrent = () => epoch === currentEpoch();
  return {
    admission: createAcpLifecycleDispatch(dispatch, currentEpoch),
    isCurrent,
    clearWatchdog: () => { if (isCurrent()) clearWatchdog(); },
  };
}

/** Preserve ACP's synchronous accepted result and its non-enumerable async completion. */
export function createAcpInterruptResult(turnId: string, cancel: () => Promise<void>): InterruptResult {
  const completion: Promise<TurnInterruptCompletion> = cancel()
    .then(() => ({ status: 'interrupted' as const, turnId }))
    .catch((error) => ({
      status: 'rejected' as const,
      turnId,
      reason: error instanceof Error ? error.message : String(error),
    }));
  const result: InterruptResult = { status: 'accepted', turnId };
  Object.defineProperty(result, 'completion', { value: completion, enumerable: false });
  return result;
}
