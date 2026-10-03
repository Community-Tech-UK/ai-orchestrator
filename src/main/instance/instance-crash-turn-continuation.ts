/** Compatibility entry point. Production initializes the shared turn-ending owner once. */
import { getPauseCoordinator } from '../pause/pause-coordinator';
import { registerCleanup } from '../util/cleanup-registry';
import { getInstanceAsyncWorkRegistry, type InstanceAsyncWorkRegistry } from './instance-async-work-registry';
import {
  InstanceReasoningCollapseContinuation,
  type InstanceReasoningCollapseContinuationHost,
} from './instance-reasoning-collapse-continuation';
export { CRASH_TURN_CONTINUATION_PROMPT } from './turn-ending-continuation-policy';
export const MAX_CRASH_TURN_CONTINUATIONS = 2;
export type InstanceCrashTurnContinuationHost = InstanceReasoningCollapseContinuationHost;

export class InstanceCrashTurnContinuation extends InstanceReasoningCollapseContinuation {
  constructor(
    registry: InstanceAsyncWorkRegistry,
    host: InstanceCrashTurnContinuationHost,
    isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    isPaused: () => boolean = () => false,
  ) { super(registry, host, isManagedLoopInstance, isPaused, true); }
}
let activeContinuation: InstanceCrashTurnContinuation | null = null;
export function initializeInstanceCrashTurnContinuation(
  host: InstanceCrashTurnContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceCrashTurnContinuation {
  activeContinuation?.stop();
  activeContinuation = new InstanceCrashTurnContinuation(getInstanceAsyncWorkRegistry(), host, isManagedLoopInstance, isPaused);
  activeContinuation.start();
  registerCleanup(() => { activeContinuation?.stop(); activeContinuation = null; });
  return activeContinuation;
}
export function _disposeInstanceCrashTurnContinuationForTesting(): void {
  activeContinuation?.stop(); activeContinuation = null;
}
