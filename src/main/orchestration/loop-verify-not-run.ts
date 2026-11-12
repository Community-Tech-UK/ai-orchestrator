/**
 * A verify that came back "not run" (exit 69: no test machine could take it) never ran, so it says nothing
 * about the code. The loop waits and tries the same verify again, inside the same completion attempt: no
 * round is used and the agent is never told tests failed. Cancelling the loop ends the wait.
 */

import { stripVTControlCharacters } from 'node:util';
import type { LoopActivityEvent } from '../../shared/types/loop-stream.types';
import type { LoopState } from '../../shared/types/loop.types';
import type { VerifyOutcome } from './loop-completion-detector';
import type { SpawnVerifyRegistration } from './loop-spawn-verify';

/** Test runners and `checks.js` exit with this when no test machine could take a run. It never means a failure. */
export const VERIFY_NOT_RUN_EXIT_CODE = 69;
/** How long a loop waits for a test machine before trying its verify again. */
export const VERIFY_NOT_RUN_RETRY_MS = 5 * 60_000;

/** The runner's reason when the verify did not run, from its `Not run: <reason>` line. */
export function verifyNotRunReason(outcome: VerifyOutcome): string | undefined {
  if (outcome.status !== 'failed' || outcome.exitCode !== VERIFY_NOT_RUN_EXIT_CODE) return undefined;
  const reason = [...stripVTControlCharacters(outcome.output).matchAll(/^\s*Not run: (.+?)\s*$/gm)].at(-1)?.[1];
  // Only our runners print this line; another command that exits 69 has simply failed.
  return reason?.slice(0, 300);
}

export interface VerifyNotRunWaiting {
  /** Resolves true once the wait is over, false when the loop was cancelled meanwhile. */
  wait: (ms: number) => Promise<boolean>;
  onWaiting?: (message: string) => void;
  retryMs?: number;
}

export async function runVerifyUntilItRuns(
  attempt: () => Promise<VerifyOutcome>,
  label: 'verify' | 'quick-verify',
  waiting: VerifyNotRunWaiting | undefined | '',
): Promise<VerifyOutcome> {
  for (;;) {
    const outcome = await attempt();
    const reason = verifyNotRunReason(outcome);
    // Without a loop to wait in, a "not run" is reported as the infrastructure trouble it is, never as failing tests.
    if (reason === undefined || outcome.status !== 'failed') return outcome;
    if (!waiting) return { ...outcome, failureKind: 'infra' };
    const started = Date.now();
    const retryMs = waiting.retryMs ?? VERIFY_NOT_RUN_RETRY_MS;
    waiting.onWaiting?.(`Waiting for a test machine: ${reason}. The ${label} runs again in ${Math.round(retryMs / 60_000)} minutes.`);
    if (!await waiting.wait(retryMs)) {
      return { status: 'failed', output: `${outcome.output}\n(${label} was cancelled while waiting for a test machine)`,
        durationMs: Date.now() - started, exitCode: null, failureKind: 'cancelled' };
    }
  }
}

/** A wait the loop's cancel can end early, through the same registry that kills a running verify. */
export function cancellableWait(ms: number): { done: Promise<boolean>; registration: SpawnVerifyRegistration } {
  let finish: (ran: boolean) => void = () => undefined;
  const done = new Promise<boolean>((resolve) => { finish = resolve; });
  const timer = setTimeout(() => finish(true), ms);
  return { done, registration: { kill: () => { clearTimeout(timer); finish(false); return Promise.resolve(); } } };
}

/** Waits registered where the loop's cancel finds them, beside any verify child it kills. */
export function notRunWaiting(
  add: (registration: SpawnVerifyRegistration) => void,
  remove: (registration: SpawnVerifyRegistration) => void,
  onWaiting: (message: string) => void,
): VerifyNotRunWaiting {
  return { onWaiting, wait: (ms) => {
    const { done, registration } = cancellableWait(ms);
    add(registration);
    return done.finally(() => remove(registration));
  } };
}

interface ActivityHost {
  getLoop(loopRunId: string): LoopState | undefined;
  emit(event: 'loop:activity', payload: LoopActivityEvent): boolean;
}

/** Shows the wait in the loop's activity feed, where pauses and other waits already appear. */
export function verifyWaitingActivity(host: ActivityHost): (loopRunId: string, message: string) => void {
  return (loopRunId, message) => {
    const state = host.getLoop(loopRunId);
    if (!state) return;
    host.emit('loop:activity', { loopRunId, seq: state.totalIterations, stage: state.currentStage, timestamp: Date.now(),
      kind: 'status', message, detail: { waitingForTestMachine: true } });
  };
}
