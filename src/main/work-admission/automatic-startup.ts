import { AsyncLocalStorage } from 'node:async_hooks';
import { getLogger } from '../logging/logger';
import { trackConsult } from './consult-admission';
import { getWorkAdmission } from './work-admission';

const logger = getLogger('AutomaticStartup');
export class AutomaticStartupCancelledError extends Error {
  constructor() { super('Automatic startup cancelled for restart'); this.name = 'AutomaticStartupCancelledError'; }
}
export function isAutomaticStartupCancelled(error: unknown): boolean { return error instanceof AutomaticStartupCancelledError; }

export interface AutomaticStartup {
  signal: AbortSignal;
  wasDispatched(instanceId: string): boolean;
  /** Register immediately after create returns, before attaching or awaiting readiness. */
  register(instance: { id: string; readyPromise?: Promise<void> }, terminate: () => Promise<void>): void;
}
interface StartupContext extends AutomaticStartup {
  cancel(): void;
  adapters: Map<object, () => Promise<void>>;
  initializations: Set<Promise<void>>;
  dispatched: Set<string>;
}
const context = new AsyncLocalStorage<StartupContext>();

export function trackAutomaticStartupInitialization(initialization: Promise<void>): void {
  context.getStore()?.initializations.add(initialization);
}

/** Mark at the actual provider call boundary, after provider-limit holds. */
export function markAutomaticStartupInputDispatched(instanceId: string): void {
  assertAutomaticStartupCurrent();
  context.getStore()?.dispatched.add(instanceId);
}

/** Capture the actual provider even if rollback later removes its instance registration. */
export function captureAutomaticStartupAdapter(adapter: object, terminate: () => Promise<void>): (() => Promise<void>) | undefined {
  const startup = context.getStore();
  if (!startup) return undefined;
  const existing = startup.adapters.get(adapter);
  if (existing) return existing;
  let pending: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (pending) return pending;
    const attempt = Promise.resolve().then(terminate);
    pending = attempt;
    // A successful early stop can precede a delayed spawn response. Recheck after init settles.
    void attempt.then(() => { pending = undefined; }, () => { pending = undefined; });
    return attempt;
  };
  startup.adapters.set(adapter, stop);
  return stop;
}

/** Only automatic starts inherit this context; a manually opened chat remains usable. */
export function assertAutomaticStartupCurrent(): void {
  const startup = context.getStore();
  if (!startup) return;
  if (!getWorkAdmission().check('consult', { remote: true }).allowed) startup.cancel();
  startup.signal.throwIfAborted();
}

/** Reserve before any setup await, and retain failed teardown for the next Pause attempt. */
export async function runAutomaticStartup<T>(operation: (startup: AutomaticStartup) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let terminate: (() => Promise<void>) | undefined;
  let registeredOrDone!: () => void;
  const registration = new Promise<void>(resolve => { registeredOrDone = resolve; });
  let operationDone!: () => void;
  const completed = new Promise<void>(resolve => { operationDone = resolve; });
  let cleanup: Promise<void> | undefined;
  const finish = (): Promise<void> => {
    if (cleanup) return cleanup;
    const attempt = Promise.resolve().then(async () => {
      await registration;
      for (const stop of startup.adapters.values()) await stop();
      if (terminate) await terminate();
      await Promise.allSettled(startup.initializations);
      for (const stop of startup.adapters.values()) await stop();
      await completed;
      untrack();
    });
    cleanup = attempt;
    void attempt.catch(() => { if (cleanup === attempt) cleanup = undefined; });
    return attempt;
  };
  const startup: StartupContext = {
    signal: abort.signal,
    wasDispatched: instanceId => startup.dispatched.has(instanceId),
    dispatched: new Set<string>(),
    adapters: new Map<object, () => Promise<void>>(),
    initializations: new Set<Promise<void>>(),
    cancel: () => { if (!abort.signal.aborted) abort.abort(new AutomaticStartupCancelledError()); },
    register: (instance, stop) => {
      terminate = stop;
      if (instance.readyPromise) startup.initializations.add(instance.readyPromise);
      registeredOrDone();
      assertAutomaticStartupCurrent();
    },
  };
  const untrack = trackConsult(() => {
    startup.cancel();
    void finish().catch(error => logger.warn('Automatic startup teardown is still pending', { error }));
  });
  try {
    return await context.run(startup, async () => {
      assertAutomaticStartupCurrent();
      const result = await operation(startup);
      assertAutomaticStartupCurrent();
      return result;
    });
  } finally {
    registeredOrDone(); operationDone();
    if (abort.signal.aborted) await finish();
    else if (startup.initializations.size) {
      // Preserve createInstance's immediate return while keeping its background startup owned.
      void Promise.allSettled(startup.initializations).then(results => {
        if (abort.signal.aborted || results.some(result => result.status === 'rejected')) {
          startup.cancel();
          void finish().catch(error => logger.warn('Automatic initialization teardown is still pending', { error }));
        } else untrack();
      });
    } else untrack();
  }
}
