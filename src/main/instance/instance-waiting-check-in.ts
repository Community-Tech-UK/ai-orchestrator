import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { detectWaitingOnWork } from '../orchestration/waiting-on-work-detector';
import { getLogger } from '../logging/logger';
import { logPromptInjection } from '../logging/prompt-injection-log';
import { readCompletionText, type InstanceAnnounceThenHaltContinuationHost } from './instance-announce-then-halt-continuation';
import type { InstanceContinuationDispatch } from './instance-continuation-dispatch';

const logger = getLogger('InstanceWaitingCheckIn');
const MINUTE_MS = 60_000;
/**
 * Each check waits longer, then they come every 55 minutes: outside work such as a remote builder can take hours (24
 * November 2026: nearly four, long after a 75-minute series had ended). Under an hour apart, a check can still find
 * Claude's one-hour prompt cache warm, though a session put to sleep in between is restarted to take it. A reply that
 * no longer waits ends the series, so only a genuine wait uses the later checks. Total: 8 hours 35 minutes.
 */
export const WAITING_CHECK_IN_DELAYS_MS = [5, 10, 20, 40, 55, 55, 55, 55, 55, 55, 55, 55].map((minutes) => minutes * MINUTE_MS);

/**
 * The first outcome stops a check-in nudging the agent into a step it handed to the user, such as merging, publishing
 * or restarting (24 November 2026 review); its reply names the user, so the series ends.
 */
export function buildWaitingCheckInPrompt(excerpt: string): string {
  return [
    `Automatic check-in: you ended your last turn waiting on something ("${excerpt}").`,
    'Nothing tells this session when that finishes, so check it yourself now.',
    '- Waiting on a step, answer or decision you asked the user for: leave it to them and reply in one sentence saying what you need from them.',
    '- Otherwise, if it has finished or will never report back: carry on with the work.',
    '- Still running: reply in one sentence starting "I\'m waiting for".',
  ].join('\n');
}

interface WaitingState {
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A model can end a turn waiting on work Harness cannot see, such as a job on
 * another machine or a helper that already stopped. No completion will ever
 * arrive, so the wait gets a bounded series of check-ins. Tracked background
 * work keeps its own wake and is left alone.
 */
export class InstanceWaitingCheckIn {
  private readonly states = new Map<string, WaitingState>();
  private started = false;

  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    const { instanceId, event } = envelope;
    if (event.kind !== 'complete') return;
    const state = this.states.get(instanceId);
    this.clearTimer(state);
    const instance = this.host.getInstance(instanceId);
    const ended = event.turnEnding?.reason === undefined || event.turnEnding.reason === 'completed';
    const requestCount = event.requestCountAtCompletion;
    if (!instance || instance.parentId !== null || !ended || event.turnEnding?.autoContinueSuppressed === true
      || (requestCount !== undefined && requestCount !== instance.requestCount)) return;
    const text = readCompletionText(envelope, instance);
    const excerpt = text ? detectWaitingOnWork(text) : null;
    if (!excerpt) {
      this.states.delete(instanceId);
      return;
    }
    const next = state ?? { attempts: 0 };
    this.states.set(instanceId, next);
    this.arm(instanceId, next, excerpt);
  };

  private readonly onInputStarted = ({ instanceId, autoContinuation }: { instanceId: string; autoContinuation: boolean }): void => {
    this.clearTimer(this.states.get(instanceId));
    if (!autoContinuation) this.states.delete(instanceId);
  };

  private readonly onInstanceRemoved = (instanceId: string): void => {
    this.clearTimer(this.states.get(instanceId));
    this.states.delete(instanceId);
  };

  constructor(
    private readonly host: InstanceAnnounceThenHaltContinuationHost,
    private readonly dispatch: InstanceContinuationDispatch,
    private readonly delaysMs: readonly number[] = WAITING_CHECK_IN_DELAYS_MS,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:input-started', this.onInputStarted);
    this.host.on('instance:removed', this.onInstanceRemoved);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:input-started', this.onInputStarted);
    this.host.off('instance:removed', this.onInstanceRemoved);
    for (const state of this.states.values()) this.clearTimer(state);
    this.states.clear();
  }

  private arm(instanceId: string, state: WaitingState, excerpt: string): void {
    const delay = this.delaysMs[state.attempts];
    if (delay === undefined) {
      this.states.delete(instanceId);
      return;
    }
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.checkIn(instanceId, state, excerpt);
    }, delay);
    state.timer.unref?.();
  }

  private async checkIn(instanceId: string, state: WaitingState, excerpt: string): Promise<void> {
    const instance = this.host.getInstance(instanceId);
    if (!instance || this.states.get(instanceId) !== state) return;
    const prompt = buildWaitingCheckInPrompt(excerpt);
    const reservation = this.dispatch.reserve({
      instanceId, trigger: 'waiting-check-in', requestCount: instance.requestCount,
      prompt, internalSource: 'waiting-check-in',
      isCurrent: () => this.started && this.states.get(instanceId) === state,
    });
    // Every due check counts, so tracked work, a pause or a busy session can't extend the series.
    state.attempts += 1;
    logger.info('Checking in on a session that stopped to wait', { instanceId, attempt: state.attempts, admitted: reservation !== undefined });
    if (reservation) logPromptInjection('waitingCheckIn', prompt, instanceId);
    const sent = reservation
      ? await this.dispatch.dispatch(reservation, { settle: false }).catch(() => {
        logger.warn('Waiting check-in could not be sent', { instanceId });
        return false;
      })
      : false;
    if (!sent && this.states.get(instanceId) === state && !state.timer) this.arm(instanceId, state, excerpt);
  }

  private clearTimer(state: WaitingState | undefined): void {
    if (state?.timer) clearTimeout(state.timer);
    if (state) state.timer = undefined;
  }
}
