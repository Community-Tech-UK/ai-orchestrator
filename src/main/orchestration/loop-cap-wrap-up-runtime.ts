import type { LoopCapWrapUpIntent, LoopState } from '../../shared/types/loop.types';

export function resolveCapWrapUpIntent(
  state: LoopState,
  stored: LoopCapWrapUpIntent | undefined,
): LoopCapWrapUpIntent | undefined {
  return stored ?? state.capWrapUpIntent;
}

export function hydrateCapWrapUpStore(
  state: LoopState,
  stored: LoopCapWrapUpIntent | undefined,
  setStored: (intent: LoopCapWrapUpIntent) => void,
): void {
  if (state.capWrapUpIntent && !stored) {
    setStored(state.capWrapUpIntent);
  }
}

export function finishCapWrapUpTurn(args: {
  state: LoopState;
  intent: LoopCapWrapUpIntent;
  extraEvidence?: Record<string, unknown>;
  extraCapReached?: Record<string, unknown>;
  emit: (eventName: string, payload: unknown) => void;
  terminate: (state: LoopState, status: LoopState['status'], reason?: string) => void;
}): void {
  const { state, intent } = args;
  state.capWrapUpIntent = { ...intent, phase: 'turn-complete' };
  state.endEvidence = {
    ...(state.endEvidence ?? {}),
    cap: intent.cap,
    capTriggerIteration: intent.triggerIteration,
    ...args.extraEvidence,
  };
  args.emit('loop:cap-reached', {
    loopRunId: state.id,
    cap: intent.cap,
    reason: intent.originalReason,
    ...args.extraCapReached,
  });
  args.terminate(state, 'cap-reached', intent.originalReason);
}
