/**
 * Exec-per-turn adapters on the worker (Codex exec mode and siblings).
 *
 * These adapters run one provider process per message, so an adapter `exit` ends
 * that turn's process, not the session. The coordinator already ignores those
 * exits for local sessions (`instance-communication.ts`); the worker must not
 * turn them into an instance exit either, or the coordinator sees a crash in the
 * middle of a completed turn and respawns it.
 */
import type { InterruptResult } from '../main/cli/adapters/base-cli-adapter';
import { isStatelessExecAdapter, type StatelessExecClassifiable } from '../main/cli/adapters/stateless-exec-adapter';

/** True when this adapter's `exit` ends one turn's process rather than the session. */
export function endsOnlyTheTurn(adapter: Partial<StatelessExecClassifiable>): boolean {
  return typeof adapter.getName === 'function' && isStatelessExecAdapter(adapter as StatelessExecClassifiable);
}

export function isSettledStatus(status: string): boolean {
  return status === 'idle' || status === 'ready' || status === 'waiting_for_input';
}

/**
 * A session a worker restart would cut off: mid-turn, or waiting on the user's
 * answer. An idle one is not: the coordinator puts idle sessions to sleep when
 * it sees the worker restarted, and the next message resumes them
 * (`handleWorkerRestart` in node-failover.ts). A session still starting is
 * covered by its in-flight spawn request (worker-activity.ts).
 */
export function blocksWorkerRestart(session: { lastStatus: string; adapter: { hasActiveTurn?: () => boolean } } | undefined): boolean {
  if (!session) return false;
  return (session.lastStatus !== 'idle' && session.lastStatus !== 'ready') || session.adapter.hasActiveTurn?.() === true;
}

/**
 * An interrupted exec turn ends without any status of its own: locally the
 * coordinator awaits the adapter's completion promise, which cannot cross the
 * RPC. Call `onInterrupted` once that completion reports the turn interrupted,
 * so the worker can report the settled state itself. A turn that completed
 * anyway reports its own `idle`, so it is left alone.
 */
export function onExecTurnInterrupted(
  adapter: Partial<StatelessExecClassifiable>,
  result: InterruptResult | void,
  onInterrupted: () => void,
): void {
  const completion = result && 'completion' in result ? result.completion : undefined;
  if (!completion || !endsOnlyTheTurn(adapter)) return;
  void completion.then((outcome) => { if (outcome.status === 'interrupted') onInterrupted(); }, () => undefined);
}
