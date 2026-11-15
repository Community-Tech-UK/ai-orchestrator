import { getPauseCoordinator } from '../pause/pause-coordinator';
import { globalPauseHoldsAutomaticInput } from '../global-pause/global-pause-service';
import { SessionWatcher } from '../session-watcher/session-watcher';
import type { SessionWatcherExternals } from '../session-watcher/watcher-wiring';
import { registerCleanup } from '../util/cleanup-registry';
import { InstanceContinuationDispatch } from './instance-continuation-dispatch';
import { InstanceReasoningCollapseContinuation, type InstanceReasoningCollapseContinuationHost } from './instance-reasoning-collapse-continuation';
import { InstanceAnnounceThenHaltContinuation } from './instance-announce-then-halt-continuation';
import { InstanceAsyncWorkContinuation } from './instance-async-work-continuation';
import { InstanceWaitingCheckIn } from './instance-waiting-check-in';
import { getInstanceAsyncWorkRegistry, type InstanceAsyncWorkRegistry } from './instance-async-work-registry';

/** Source listeners detect work; exactly one injected owner admits and sends their prompts. */
export class InstanceContinuationRuntime {
  private readonly dispatch: InstanceContinuationDispatch;
  private readonly cutoffs: InstanceReasoningCollapseContinuation;
  private readonly announcements: InstanceAnnounceThenHaltContinuation;
  private readonly background: InstanceAsyncWorkContinuation;
  private readonly waiting: InstanceWaitingCheckIn;
  /** Present when the app supplied what the session watcher needs; absent in tests of the other listeners. */
  readonly watcher?: SessionWatcher;
  constructor(
    registry: InstanceAsyncWorkRegistry,
    host: InstanceReasoningCollapseContinuationHost,
    isManagedLoopInstance: (instanceId: string) => boolean = () => false,
    isPaused: () => boolean = () => false,
    providerResumeGraceMs?: number,
    watcherExternals?: SessionWatcherExternals,
  ) {
    this.dispatch = new InstanceContinuationDispatch(registry, host, isManagedLoopInstance, isPaused);
    this.cutoffs = new InstanceReasoningCollapseContinuation(registry, host, isManagedLoopInstance, isPaused, false, this.dispatch);
    // The rule-based answer to "shall I carry on?" is part of "Keep sessions going without me": the watcher says
    // which sessions it may answer, so the setting, the per-session switch and the typing hold cover it too.
    this.announcements = new InstanceAnnounceThenHaltContinuation(registry, host, isManagedLoopInstance, isPaused, this.dispatch,
      (instance) => this.watcher?.allowsRuleReply(instance) ?? false);
    this.background = new InstanceAsyncWorkContinuation(registry, host, { dispatch: this.dispatch, providerResumeGraceMs });
    this.waiting = new InstanceWaitingCheckIn(host, this.dispatch);
    if (watcherExternals) {
      this.watcher = new SessionWatcher(host, this.dispatch, {
        ...watcherExternals,
        isLoopChat: isManagedLoopInstance,
        isPaused: (instanceId) => isPaused() || globalPauseHoldsAutomaticInput(instanceId),
        hasInhibitor: (instanceId) => registry.hasInhibitor(instanceId),
      });
    }
  }
  start(): void {
    this.dispatch.start();
    // Classify authoritative endings before normal completion detection runs.
    this.cutoffs.start();
    this.announcements.start();
    // After the rule checks, so a reply they queue on the same completion is seen as already queued.
    this.watcher?.start();
    this.background.start();
    this.waiting.start();
  }
  stop(): void {
    this.waiting.stop();
    this.background.stop();
    this.watcher?.stop();
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
  watcherExternals?: SessionWatcherExternals,
): InstanceContinuationRuntime {
  activeRuntime?.stop();
  const runtime = new InstanceContinuationRuntime(getInstanceAsyncWorkRegistry(), host, isManagedLoopInstance, isPaused, undefined, watcherExternals);
  activeRuntime = runtime;
  runtime.start();
  registerCleanup(() => {
    runtime.stop();
    if (activeRuntime === runtime) activeRuntime = undefined;
  });
  return runtime;
}
/** The running session watcher, once the app has started it. */
export function getActiveSessionWatcher(): SessionWatcher | undefined {
  return activeRuntime?.watcher;
}
