import { getPauseCoordinator } from '../pause/pause-coordinator';
import { registerCleanup } from '../util/cleanup-registry';
import { InstanceContinuationDispatch } from './instance-continuation-dispatch';
import { InstanceReasoningCollapseContinuation, type InstanceReasoningCollapseContinuationHost } from './instance-reasoning-collapse-continuation';
import { InstanceAnnounceThenHaltContinuation } from './instance-announce-then-halt-continuation';
import { InstanceAsyncWorkContinuation } from './instance-async-work-continuation';
import { getInstanceAsyncWorkRegistry, type InstanceAsyncWorkRegistry } from './instance-async-work-registry';

/** Source listeners detect work; exactly one injected owner admits and sends their prompts. */
export class InstanceContinuationRuntime {
  private readonly dispatch: InstanceContinuationDispatch;
  private readonly cutoffs: InstanceReasoningCollapseContinuation;
  private readonly announcements: InstanceAnnounceThenHaltContinuation;
  private readonly background: InstanceAsyncWorkContinuation;
  constructor(
    registry: InstanceAsyncWorkRegistry,
    host: InstanceReasoningCollapseContinuationHost,
    isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    isPaused: () => boolean = () => false,
    providerResumeGraceMs?: number,
  ) {
    this.dispatch = new InstanceContinuationDispatch(registry, host, isManagedLoopInstance, isPaused);
    this.cutoffs = new InstanceReasoningCollapseContinuation(registry, host, isManagedLoopInstance, isPaused, false, this.dispatch);
    this.announcements = new InstanceAnnounceThenHaltContinuation(registry, host, isManagedLoopInstance, isPaused, this.dispatch);
    this.background = new InstanceAsyncWorkContinuation(registry, host, { dispatch: this.dispatch, providerResumeGraceMs });
  }
  start(): void {
    this.dispatch.start();
    // Classify authoritative endings before normal completion detection runs.
    this.cutoffs.start();
    this.announcements.start();
    this.background.start();
  }
  stop(): void {
    this.background.stop();
    this.announcements.stop();
    this.cutoffs.stop();
    this.dispatch.stop();
  }
}
let activeRuntime: InstanceContinuationRuntime | undefined;
export function initializeInstanceContinuationRuntime(
  host: InstanceReasoningCollapseContinuationHost,
  isManagedLoopInstance: (instanceId: string) => boolean = () => false,
  isPaused: () => boolean = () => getPauseCoordinator().isPaused(),
): InstanceContinuationRuntime {
  activeRuntime?.stop();
  const runtime = new InstanceContinuationRuntime(getInstanceAsyncWorkRegistry(), host, isManagedLoopInstance, isPaused);
  activeRuntime = runtime;
  runtime.start();
  registerCleanup(() => {
    runtime.stop();
    if (activeRuntime === runtime) activeRuntime = undefined;
  });
  return runtime;
}
