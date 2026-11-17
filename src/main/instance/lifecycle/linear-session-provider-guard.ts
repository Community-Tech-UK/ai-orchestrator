/**
 * A session a Linear run started stays on the provider it started on.
 *
 * James allows each team's ticket text to go only to chosen providers, and the queue checks that at every session it
 * creates (`plan-queue-linear-providers.ts`). A live session that was moved to another provider (the composer's
 * provider picker, through the runtime reconciler) would carry the same ticket text to a provider nobody checked, so
 * the move is refused for a Plan Queue session of a `tickets` run. Failover is already off for queue sessions
 * (`routeQueueSpawn` gives them no fallback providers), and an account switch stays inside one provider.
 *
 * The queue marks the session when it creates it (`planQueueRunKind` in `spawnQueueInstance`), so this needs no look-up
 * of the run and no dependency on the queue.
 */
import type { Instance } from '../../../shared/types/instance.types';

export const LINEAR_SESSION_PROVIDER_FIXED =
  'This session works on Linear tickets, so its provider cannot be changed while it runs. Change the provider for the run on the Plan Queue page; the next session uses it.';

/** Throws the fixed refusal when `instance` is a queue session of a Linear run; does nothing for any other session. */
export function assertLinearSessionKeepsProvider(instance: Pick<Instance, 'metadata'>): void {
  const { metadata } = instance;
  if (typeof metadata?.['planQueueRole'] === 'string' && metadata['planQueueRunKind'] === 'tickets') throw new Error(LINEAR_SESSION_PROVIDER_FIXED);
}
