import { EventEmitter } from 'node:events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceAnnounceThenHaltContinuationHost } from '../instance/instance-announce-then-halt-continuation';
import type { InstanceContinuationDispatch } from '../instance/instance-continuation-dispatch';
import { getLogger } from '../logging/logger';
import { buildWatcherBrief, mergeWatcherMessages } from './watcher-brief';
import {
  hashSessionId, isBareGoAhead, isOutwardCommand, recordWatcherDecision, type WatcherOutcome, type WatcherStopRecord,
} from './watcher-decision-log';
import {
  watcherCoversSession, watcherReplySkipReason, watcherStateSkipReason, watcherTurnSkipReason, type WatcherGateDeps,
} from './watcher-gates';
import type { WatcherJudge } from './watcher-judge';
import { WATCHER_JUDGE_TIMEOUT_MS } from './watcher-judge-options';
import { buildWatcherJudgePrompt } from './watcher-judge-prompt';
import { readWatcherProjectInstructions } from './watcher-project-instructions';
import { clearWatcherNoticeSource, setWatcherNoticeSource } from './watcher-notices';
import { redactAllSecrets } from '../security/secret-redaction';
import { applyWatcherPostChecks, closingParagraph, watcherLevelAllows, type WatcherDecision } from './watcher-post-checks';
import { buildWatcherReply } from './watcher-replies';
import { parseWatcherVerdict, type WatcherStop } from './watcher-verdict';

const logger = getLogger('SessionWatcher');

/** At most this many judge calls run at once; the rest wait, but not for long. */
const MAX_CONCURRENT_JUDGE_CALLS = 2;
const QUEUE_ALLOWANCE_MS = 30_000;
/** From the finished turn to giving up on it: queue, judge call and the dispatch's own settle wait. */
export const WATCHER_BACKSTOP_MS = 150_000;
const TYPING_POLL_MS = 1_000;
/** How long a settled outcome still answers for an idle change that arrives after it. */
const OUTCOME_FRESH_MS = 10_000;
/** How long an idle change waits for its completion event before it is treated as no finished turn at all. */
const COMPLETION_GRACE_MS = 3_000;
/** The desktop and phone senders both ask about one idle change; calls this close together are the same change. */
const SAME_IDLE_CHANGE_MS = 500;
const CLOSING_CHARS = 600;
/** How long the judge waits for the project's instruction file before going without it. */
const INSTRUCTIONS_WAIT_MS = 5_000;
/** A yes can answer these stops. A request for information or a bare choice cannot be answered with one. */
const YES_ANSWERS = new Set<WatcherStop>([
  'asked_to_continue', 'announced_next_step', 'stopped_mid_plan', 'asked_before_outward_step', 'offered_extra_work',
]);

export interface SessionWatcherDeps extends Omit<WatcherGateDeps, 'hasPendingContinuation'> {
  judge: WatcherJudge;
  /** The user is typing in this session, or has a message queued for it. A reply is held while this is true. */
  isUserTyping(instanceId: string): boolean;
}

/** A session that needs the user, with the agent's own words. Nothing here was written by the judge. */
export interface WatcherFlag {
  instanceId: string;
  requestCount: number;
  /** The agent's question, taken word for word from its final reply. */
  question: string;
  /** The agent's closing paragraph, word for word; shown beside the one-click yes. */
  closing: string;
  stop: WatcherStop;
  /** A fixed line from the code when the watcher itself handed the session back. */
  note?: string;
  /** Whether a plain "Yes, go ahead." would answer the stop. */
  acceptsYes: boolean;
  since: number;
}

export interface WatcherOutcomeEvent {
  instanceId: string;
  requestCount: number;
  outcome: WatcherOutcome;
  flag?: WatcherFlag;
}

interface Job {
  requestCount: number;
  controller: AbortController;
  /** True while the dispatch owns the send; its own listeners handle new input and Stop from here. */
  dispatching: boolean;
  finished: boolean;
}

function abortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

function newestConversationMessageIsAssistant(instance: Instance): boolean {
  for (let index = instance.outputBuffer.length - 1; index >= 0; index -= 1) {
    const type = instance.outputBuffer[index]?.type;
    if (type === 'assistant' || type === 'user') return type === 'assistant';
  }
  return false;
}

/**
 * Judges each finished turn of the user's own chat sessions: tell the agent to
 * carry on, flag the session as needing the user, or leave it as finished. One
 * more source listener on the continuation runtime; every reply goes through
 * the shared dispatch. Emits `flag`, `clear` and `outcome`.
 */
export class SessionWatcher extends EventEmitter {
  private readonly jobs = new Map<string, Job>();
  private readonly flagged = new Set<string>();
  /** `idleSeenAt`: when an idle change was first answered with this outcome; a later one is a later stop's. */
  private readonly lastOutcome = new Map<string, { event: WatcherOutcomeEvent; at: number; judged: boolean; idleSeenAt?: number }>();
  private readonly idleWaiters = new Map<string, ((event: WatcherOutcomeEvent) => void)[]>();
  private readonly graceTokens = new Map<string, symbol>();
  /** The request count of the last stop whose follow-up line has been written, per session. */
  private readonly followedUp = new Map<string, number>();
  private readonly gate: WatcherGateDeps;
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private started = false;

  private readonly onProviderEvent = (envelope: ProviderRuntimeEventEnvelope): void => {
    if (envelope.event.kind !== 'complete') return;
    // A listener on the provider event bus: a throw here would reach every other listener's caller.
    try { this.onCompletion(envelope); } catch (error) {
      logger.warn('Session watcher could not look at a finished turn', { instanceId: envelope.instanceId, error: error instanceof Error ? error.name : 'unknown' });
    }
  };
  private readonly onInputStarted = ({ instanceId }: { instanceId: string }): void => {
    const job = this.jobs.get(instanceId);
    if (job?.dispatching) return;
    // Any input, automatic or not, means this stop is over.
    if (job) this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'new-input' });
    this.clearFlag(instanceId);
  };
  private readonly onInterrupt = ({ instanceId }: { instanceId: string }): void => {
    const job = this.jobs.get(instanceId);
    if (job) { this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'stopped' }); return; }
    // Stop pressed during the turn a carry-on started: the clearest sign the user did not want it.
    const last = this.lastOutcome.get(instanceId)?.event;
    const instance = this.host.getInstance(instanceId);
    if (last?.outcome === 'sent' && instance?.requestCount === last.requestCount + 1 && this.followedUp.get(instanceId) !== last.requestCount) {
      this.followedUp.set(instanceId, last.requestCount);
      recordWatcherDecision({ event: 'follow-up', kind: 'stop-pressed', session: hashSessionId(instanceId), requestCount: last.requestCount });
    }
  };
  private readonly onRemoved = (instanceId: string): void => {
    const job = this.jobs.get(instanceId);
    if (job) this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'removed' });
    this.clearFlag(instanceId);
    this.lastOutcome.delete(instanceId);
    this.followedUp.delete(instanceId);
  };

  constructor(
    private readonly host: InstanceAnnounceThenHaltContinuationHost,
    private readonly dispatch: InstanceContinuationDispatch,
    private readonly deps: SessionWatcherDeps,
  ) {
    super();
    this.gate = { ...deps, hasPendingContinuation: (instanceId) => dispatch.hasPending(instanceId) };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    setWatcherNoticeSource(this);
    this.host.on('provider:normalized-event', this.onProviderEvent);
    this.host.on('instance:input-started', this.onInputStarted);
    this.host.on('instance:interrupt-requested', this.onInterrupt);
    this.host.on('instance:removed', this.onRemoved);
  }

  /** Includes queued judges and a decided reply that is still waiting to send. */
  hasPendingWork(instanceId: string): boolean { return this.jobs.has(instanceId); }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.host.off('provider:normalized-event', this.onProviderEvent);
    this.host.off('instance:input-started', this.onInputStarted);
    this.host.off('instance:interrupt-requested', this.onInterrupt);
    this.host.off('instance:removed', this.onRemoved);
    for (const [instanceId, job] of [...this.jobs]) this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'shutdown' });
    for (const instanceId of [...this.idleWaiters.keys()]) this.resolveIdle({ instanceId, requestCount: -1, outcome: 'not_sent' });
    this.flagged.clear();
    this.lastOutcome.clear();
    this.followedUp.clear();
    clearWatcherNoticeSource(this);
  }

  /**
   * For the two "finished" notice senders, called when a session goes from working to idle. Returns nothing for a
   * session the watcher does not look after, so that notice goes out at once, as before. Otherwise resolves with
   * what became of the stop: `sent` (no notice), `needs_you` (say so, with the question) or `not_sent` (the
   * usual finished notice). It always resolves: a stop with no finished turn behind it settles as `not_sent`
   * after a short grace period, and a judged one by the backstop at the latest.
   */
  outcomeForIdle(instanceId: string): Promise<WatcherOutcomeEvent> | undefined {
    try {
      return this.idleOutcome(instanceId);
    } catch (error) {
      // Called from inside the notice senders: whatever goes wrong here, the usual notice must still go out.
      logger.warn('Session watcher could not answer for an idle session', { instanceId, error: error instanceof Error ? error.name : 'unknown' });
      return undefined;
    }
  }

  private idleOutcome(instanceId: string): Promise<WatcherOutcomeEvent> | undefined {
    const instance = this.host.getInstance(instanceId);
    if (!this.started || !instance || !watcherCoversSession(instance, this.gate)) return undefined;
    const last = this.lastOutcome.get(instanceId);
    if (!this.jobs.has(instanceId) && last && Date.now() - last.at < OUTCOME_FRESH_MS) {
      const sameStop = last.event.requestCount === instance.requestCount;
      // A carry-on has already gone out, so the session is one request further on: an idle change nobody has
      // answered yet belongs to the stop that was carried on, and must not announce it as finished. Once one
      // has been answered, the next idle change is the carried-on turn's own, and is judged in its own right.
      // Both notice senders ask about the same idle change within moments of each other, so "answered" has a
      // short width.
      const unanswered = last.idleSeenAt === undefined || Date.now() - last.idleSeenAt < SAME_IDLE_CHANGE_MS;
      const lateForCarriedStop = last.event.outcome === 'sent' && unanswered && last.event.requestCount === instance.requestCount - 1;
      if (sameStop || lateForCarriedStop) { last.idleSeenAt ??= Date.now(); return Promise.resolve(last.event); }
    }
    return new Promise((resolve) => {
      this.idleWaiters.set(instanceId, [...(this.idleWaiters.get(instanceId) ?? []), resolve]);
      if (this.jobs.has(instanceId)) return;
      // The completion event may still be on its way. The check runs a tick after the timer, so events that
      // queued up behind a stalled main process are handled first.
      // Only this wait's own timer may end it: an earlier idle change must not cut a later one's grace short.
      const token = Symbol('grace');
      this.graceTokens.set(instanceId, token);
      const grace = setTimeout(() => setImmediate(() => {
        if (this.graceTokens.get(instanceId) !== token) return;
        this.graceTokens.delete(instanceId);
        if (!this.jobs.has(instanceId)) this.resolveIdle({ instanceId, requestCount: instance.requestCount, outcome: 'not_sent' });
      }), COMPLETION_GRACE_MS);
      grace.unref?.();
    });
  }

  /** Sessions currently flagged as needing the user. */
  /**
   * May the older rule-based answer to "shall I carry on?" be sent to this session? The same test as the watcher's
   * own replies: a session it covers (so not a muted one, and not one on another provider), a level that replies,
   * and nobody typing.
   */
  allowsRuleReply(instance: Instance): boolean {
    const level = this.gate.level();
    return level !== 'off' && level !== 'flag-only' && watcherCoversSession(instance, this.gate) && !this.deps.isUserTyping(instance.id);
  }

  flaggedSessions(): string[] {
    return [...this.flagged];
  }

  private onCompletion(envelope: ProviderRuntimeEventEnvelope): void {
    const instance = this.host.getInstance(envelope.instanceId);
    if (!instance || !watcherCoversSession(instance, this.gate)) return;
    const { id: instanceId, requestCount } = instance;
    // A late report of an earlier turn says nothing about the turn now running: it must not be logged as that
    // turn's stop, nor answer for its notice.
    const reported = envelope.event.kind === 'complete' ? envelope.event.requestCountAtCompletion : undefined;
    if (reported !== undefined && reported !== requestCount) return;
    this.recordFollowUp(instance);
    const existing = this.jobs.get(instanceId);
    // Some providers report one finished turn twice, sometimes after the first report has been dealt with.
    if (existing && existing.requestCount === requestCount) return;
    const settledAt = this.lastOutcome.get(instanceId);
    // Only a stop that was really judged: a skipped report (a stale one, say) must not hide the real one.
    if (!existing && settledAt?.judged && settledAt.event.requestCount === requestCount && Date.now() - settledAt.at < OUTCOME_FRESH_MS) return;
    if (existing) this.settle(instanceId, existing, { outcome: 'not_sent', outcomeReason: 'superseded' });

    const job: Job = { requestCount, controller: new AbortController(), dispatching: false, finished: false };
    this.jobs.set(instanceId, job);
    let skipped: string | null;
    try {
      skipped = watcherTurnSkipReason(envelope, instance, this.gate, (id) => this.host.getInstance(id))
        ?? (this.deps.judge.available() ? null : 'no-judge');
    } catch {
      // A job that is never settled would leave its "finished" notice waiting for ever.
      skipped = 'gate-error';
    }
    if (skipped) { this.settle(instanceId, job, { skipped, outcome: 'not_sent' }); return; }

    // Once the dispatch owns the send it has its own time limit, and settling here could announce a session as
    // finished just as its carry-on goes out.
    const backstop = setTimeout(() => {
      if (!job.dispatching) this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'deadline' });
    }, WATCHER_BACKSTOP_MS);
    backstop.unref?.();
    job.controller.signal.addEventListener('abort', () => clearTimeout(backstop), { once: true });
    // The final message can reach the session's buffer just after the completion event.
    setImmediate(() => {
      void this.run(instanceId, job, envelope.model).catch((error: unknown) => {
        logger.warn('Session watcher failed on a stop', { instanceId, error: error instanceof Error ? error.name : 'unknown' });
        this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'error' });
      });
    });
  }

  private async run(instanceId: string, job: Job, model: string | undefined): Promise<void> {
    const { signal } = job.controller;
    if (!(await this.acquire(signal))) { this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: 'queue' }); return; }
    let carryOn: { decision: WatcherDecision; record: Partial<WatcherStopRecord> } | null;
    try {
      carryOn = await this.decide(instanceId, job, model);
    } finally {
      this.release();
    }
    if (carryOn) await this.reply(instanceId, job, carryOn.decision, carryOn.record);
  }

  /** Judges the stop. Returns the decision when it is a carry-on; every other ending is settled here. */
  private async decide(
    instanceId: string, job: Job, model: string | undefined,
  ): Promise<{ decision: WatcherDecision; record: Partial<WatcherStopRecord> } | null> {
    const { signal } = job.controller;
    let record: Partial<WatcherStopRecord> = {};
    {
      const instance = this.current(instanceId, job);
      if (!instance) return null;
      if (!newestConversationMessageIsAssistant(instance)) { this.settle(instanceId, job, { skipped: 'no-new-reply', outcome: 'not_sent' }); return null; }
      const brief = buildWatcherBrief(mergeWatcherMessages(instance.retainedPrompts, instance.outputBuffer));
      const skipped = watcherReplySkipReason(brief.finalReplyFull, brief.personTexts.length, model);
      if (skipped) { this.settle(instanceId, job, { skipped, outcome: 'not_sent' }); return null; }
      // A session on another computer has its folder there. A read that stalls (a hung network drive) must not keep
      // this judge slot: after a short wait the judge goes without, as it does for a folder with no file.
      const projectInstructions = instance.executionLocation.type === 'local'
        ? await Promise.race([
          readWatcherProjectInstructions(instance.workingDirectory),
          abortable(INSTRUCTIONS_WAIT_MS, signal).then(() => ''),
        ])
        : '';
      if (signal.aborted) return null;

      const call = new AbortController();
      const timer = setTimeout(() => call.abort(), WATCHER_JUDGE_TIMEOUT_MS);
      const forward = (): void => call.abort();
      signal.addEventListener('abort', forward, { once: true });
      let raw: string;
      try {
        // Raced against the abort itself: a judge that ignores it must not keep this slot for ever.
        const reply = await Promise.race([
          this.deps.judge.judge(buildWatcherJudgePrompt(brief, projectInstructions), instanceId, call.signal),
          new Promise<never>((_resolve, reject) => { call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }),
        ]);
        raw = reply.raw;
        record = { judge: { provider: reply.provider, model: reply.model, latencyMs: reply.latencyMs, qualified: true } };
      } catch (error) {
        // The error's own text may quote the session, so only a fixed code is logged.
        if (!signal.aborted) {
          logger.debug('Session watcher judge call failed', { instanceId, error: error instanceof Error ? error.name : 'unknown' });
          this.settle(instanceId, job, { unreliable: call.signal.aborted ? 'timeout' : 'call-failed', outcome: 'not_sent' });
        }
        return null;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', forward);
      }
      if (signal.aborted) return null;
      const parsed = parseWatcherVerdict(raw);
      if (!parsed.ok) { this.settle(instanceId, job, { ...record, unreliable: parsed.error, outcome: 'not_sent' }); return null; }

      const level = this.gate.level();
      if (level === 'off') { this.settle(instanceId, job, { ...record, outcome: 'not_sent', outcomeReason: 'switched-off' }); return null; }
      const decision = applyWatcherPostChecks(parsed.verdict, {
        level, finalReply: brief.finalReplyFull, personTexts: brief.personTexts,
        attempts: this.dispatch.attempts(instanceId, 'watcher'), toolRanSinceWatcherReply: brief.toolRanSinceWatcherReply,
      });
      record = {
        ...record, verdict: parsed.verdict.verdict, stop: parsed.verdict.stop, verdictBasis: parsed.verdict.basis,
        action: decision.action, basis: decision.basis, ...(decision.override ? { override: decision.override } : {}),
      };
      if (decision.action === 'finished') { this.settle(instanceId, job, { ...record, outcome: 'not_sent' }); return null; }

      const now = this.current(instanceId, job);
      if (!now) return null;
      const changed = watcherCoversSession(now, this.gate) ? watcherStateSkipReason(now, this.gate, (id) => this.host.getInstance(id)) : 'not-covered';
      if (changed) { this.settle(instanceId, job, { ...record, outcome: 'not_sent', outcomeReason: changed }); return null; }

      if (decision.action === 'needs_user') {
        const safeReply = redactAllSecrets(brief.finalReplyFull);
        const flag: WatcherFlag = {
          // The agent's own words can include a secret it has just printed; they go to a notice and the phone.
          // Redacted before any cut, so a secret split by the cut cannot slip through.
          instanceId, requestCount: job.requestCount,
          question: safeReply === brief.finalReplyFull ? decision.question : closingParagraph(safeReply),
          closing: closingParagraph(safeReply, CLOSING_CHARS), stop: decision.stop,
          ...(decision.note ? { note: decision.note } : {}),
          acceptsYes: !decision.note && YES_ANSWERS.has(decision.stop), since: Date.now(),
        };
        this.settle(instanceId, job, { ...record, outcome: 'needs_you' }, flag);
        return null;
      }
      return { decision, record };
    }
  }

  /** Sends the fixed wording through the shared dispatch. Only a committed send counts as `sent`. */
  private async reply(instanceId: string, job: Job, decision: WatcherDecision, record: Partial<WatcherStopRecord>): Promise<void> {
    const { signal } = job.controller;
    while (!signal.aborted && this.deps.isUserTyping(instanceId)) await abortable(TYPING_POLL_MS, signal);
    // The hold can last minutes: the session may have been switched off, muted or changed since the verdict.
    const instance = this.current(instanceId, job);
    if (!instance) return;
    const changed = this.stillWanted(instance, decision);
    if (changed || decision.basis === 'none') { this.settle(instanceId, job, { ...record, outcome: 'not_sent', outcomeReason: changed ?? 'no-basis' }); return; }
    const reservation = this.dispatch.reserve({
      instanceId, trigger: 'watcher', requestCount: job.requestCount,
      prompt: buildWatcherReply(decision.basis, decision.question, decision.quote),
      internalSource: 'session-watcher',
      // Asked again by the dispatch right up to the send, which can itself wait for the session to settle.
      isCurrent: () => {
        const now = this.host.getInstance(instanceId);
        return this.started && this.jobs.get(instanceId) === job && now !== undefined
          && this.stillWanted(now, decision) === null && !this.deps.isUserTyping(instanceId);
      },
    });
    if (!reservation) { this.settle(instanceId, job, { ...record, outcome: 'not_sent', outcomeReason: 'not-admitted' }); return; }
    job.dispatching = true;
    const sent = await this.dispatch.dispatch(reservation).catch(() => false);
    job.dispatching = false;
    this.settle(instanceId, job, sent ? { ...record, outcome: 'sent' } : { ...record, outcome: 'not_sent', outcomeReason: 'dispatch-refused' });
  }

  /** Why a decided carry-on should no longer be sent, or null when it still should. */
  private stillWanted(instance: Instance, decision: WatcherDecision): string | null {
    if (!watcherCoversSession(instance, this.gate)) return 'not-covered';
    if (!watcherLevelAllows(this.gate.level(), decision.basis)) return 'level-lowered';
    if (instance.planMode.state === 'planning') return 'plan-mode';
    return this.gate.hasOpenRequest(instance) ? 'open-request' : null;
  }

  /** The instance, if this job still speaks for its latest turn. */
  private current(instanceId: string, job: Job): Instance | undefined {
    if (job.finished || job.controller.signal.aborted) return undefined;
    const instance = this.host.getInstance(instanceId);
    if (instance && instance.requestCount === job.requestCount) return instance;
    this.settle(instanceId, job, { outcome: 'not_sent', outcomeReason: instance ? 'stale' : 'removed' });
    return undefined;
  }

  /** Ends a job exactly once: one log line and one outcome, whatever path got here. */
  private settle(instanceId: string, job: Job, result: Partial<WatcherStopRecord> & { outcome: WatcherOutcome }, flag?: WatcherFlag): void {
    if (job.finished) return;
    job.finished = true;
    job.controller.abort();
    if (this.jobs.get(instanceId) === job) this.jobs.delete(instanceId);
    const outcome: WatcherOutcomeEvent = { instanceId, requestCount: job.requestCount, outcome: result.outcome, ...(flag ? { flag } : {}) };
    // The notice senders are answered first: nothing below, not the log, the session lookup or a listener, may
    // leave them waiting.
    this.lastOutcome.set(instanceId, { event: outcome, at: Date.now(), judged: result.skipped === undefined });
    this.resolveIdle(outcome);
    if (flag) this.flagged.add(instanceId);
    try {
      recordWatcherDecision({
        event: 'stop', session: hashSessionId(instanceId), requestCount: job.requestCount,
        provider: this.host.getInstance(instanceId)?.provider ?? 'unknown', ...result,
      });
      if (flag) this.emit('flag', flag);
      this.emit('outcome', outcome);
    } catch (error) {
      logger.warn('A session watcher listener failed', { instanceId, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private resolveIdle(outcome: WatcherOutcomeEvent): void {
    const waiters = this.idleWaiters.get(outcome.instanceId);
    if (!waiters) return;
    this.idleWaiters.delete(outcome.instanceId);
    const last = this.lastOutcome.get(outcome.instanceId);
    if (last?.event === outcome) last.idleSeenAt ??= Date.now();
    for (const resolve of waiters) resolve(outcome);
  }

  /**
   * What happened after the stop the watcher last settled for this session, read from the turn that has just
   * finished: the user's reply (its class and length only), or what a carried-on turn went on to run.
   */
  private recordFollowUp(instance: Instance): void {
    const last = this.lastOutcome.get(instance.id)?.event;
    if (!last || last.requestCount >= instance.requestCount || this.followedUp.get(instance.id) === last.requestCount) return;
    this.followedUp.set(instance.id, last.requestCount);
    const buffer = instance.outputBuffer;
    let start = buffer.length - 1;
    while (start >= 0 && buffer[start].type !== 'user' && buffer[start].metadata?.internalInput === undefined) start -= 1;
    const opener = buffer[start];
    if (!opener) return;
    const base = { event: 'follow-up' as const, session: hashSessionId(instance.id), requestCount: last.requestCount };
    if (opener.type === 'user' && opener.metadata?.inputOrigin?.kind === 'person') {
      recordWatcherDecision({ ...base, kind: 'person-message', bareGoAhead: isBareGoAhead(opener.content), chars: opener.content.trim().length });
    } else if (last.outcome === 'sent' && opener.metadata?.internalInput?.source === 'session-watcher') {
      const tools = buffer.slice(start + 1).filter((message) => message.type === 'tool_use');
      const outwardCommands = tools.filter((message) => {
        const command = (message.metadata?.['input'] as { command?: unknown } | undefined)?.command;
        return typeof command === 'string' && isOutwardCommand(command);
      }).length;
      recordWatcherDecision({ ...base, kind: 'carried-turn', tools: tools.length, outwardCommands });
    }
  }

  private clearFlag(instanceId: string): void {
    if (this.flagged.delete(instanceId)) this.emit('clear', instanceId);
  }

  /** Waits for a free judge slot, for at most the queue allowance. */
  private async acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    if (this.running < MAX_CONCURRENT_JUDGE_CALLS) { this.running += 1; return true; }
    let granted = false;
    const grant = (): void => { granted = true; wake.abort(); };
    const wake = new AbortController();
    const forward = (): void => wake.abort();
    signal.addEventListener('abort', forward, { once: true });
    this.waiting.push(grant);
    await abortable(QUEUE_ALLOWANCE_MS, wake.signal);
    signal.removeEventListener('abort', forward);
    if (granted) return true;
    const index = this.waiting.indexOf(grant);
    if (index >= 0) this.waiting.splice(index, 1);
    return false;
  }

  private release(): void {
    const next = this.waiting.shift();
    // The slot passes straight to the next waiter, so the count stays the same.
    if (next) next();
    else this.running -= 1;
  }
}
