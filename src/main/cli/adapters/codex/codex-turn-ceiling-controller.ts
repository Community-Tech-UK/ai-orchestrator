import type { SessionKind } from '../../../../shared/types/session-kind.types';
import type { CodexTurnCeilingSettings } from '../../../../shared/types/codex-turn-ceiling-settings.types';
import { HarnessStopError, formatStopTokens, harnessStopNotice, type HarnessStopDetails } from '../../../../shared/utils/harness-stop';
import { getSettingsManager } from '../../../core/config/settings-manager';
import type { SessionTurnShareRecord } from '../../../core/system/session-policy-log';
import { getLogger } from '../../../logging/logger';
import { errorDiagnostic } from '../../../logging/source-diagnostics';
import type { CodexTrialArm } from './codex-thread-policy';
import {
  CodexTurnTokenCeiling,
  resolveCodexTurnCeilingPolicy,
  type CodexTurnCeilingAction,
  type CodexTurnCeilingPolicy,
} from './codex-turn-token-ceiling';

const logger = getLogger('CodexTurnCeiling');

/**
 * Delivered as a developer-role item, never as the user's words (LT-657):
 * the model must not tell James that he asked it to stop.
 */
export const CODEX_TURN_WRAP_UP_TEXT =
  'Harness turn-size limit (automated; this is not a message from the user). '
  + 'This turn has already processed a very large number of tokens. '
  + 'Wrap up now: report what is done and what is left. '
  + 'Do not start new research or helper work. '
  + 'The user has not asked you to stop or change task. Never attribute this instruction to the user.';

export const COMMAND_MODE_NOTICE =
  "This session's token limit can't act during a turn: Codex is running in command mode, which reports its token use only when a turn ends.";

/** Receipts for a finished round can still arrive: child rollouts and trailing usage notifications. */
const CORRECTION_DELAY_MS = 3_000;
/** One initial record plus at most three corrections per round. */
const MAX_REVISIONS = 4;
const RETAINED_ROUNDS = 4;

export interface CodexTurnCeilingHost {
  sessionKind(): SessionKind | undefined;
  trial(): { arm?: CodexTrialArm; key?: string };
  threadId(): string | null;
  instanceId?(): string | undefined;
  /** Lifetime processed tokens across the root and every helper thread. */
  cumulativeTokens(): number;
  /** Developer-role note into the running turn; false when no turn could be steered. */
  deliverWrapUp(text: string): Promise<boolean>;
  /** Interrupts the running turn. */
  requestStop(): void;
  emitSystem(content: string, metadata: Record<string, unknown>): void;
  /** Hands a finished (or corrected) round's share to the session-policy log. */
  publishShare(record: SessionTurnShareRecord): void;
  readSettings?(): Partial<CodexTurnCeilingSettings> | undefined;
  correctionDelayMs?: number;
}

/** How a usage booking relates to the running round. */
export type CodexMeasureMode =
  /** Inside the running round: counts, and may ask for a wrap-up or a stop. */
  | 'live'
  /** After the fact (round end, trailing receipts): counts only, never steers or stops. */
  | 'late';

interface Round {
  turnId: string;
  finished: boolean;
  /** The root thread the round ran on; the thread can be replaced before late receipts arrive. */
  threadId: string | null;
  /** Counters of a round that is no longer the running one; the running round reads the ceiling. */
  rootTokens: number;
  helperTokens: number;
  wrapUpDelivered: boolean;
  stopRequested: boolean;
  revision: number;
  written: { rootTokens: number; helperTokens: number; wrapUpDelivered: boolean; stopRequested: boolean } | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Every round limit off. */
const NO_ROUND_LIMITS: Partial<CodexTurnCeilingSettings> = {
  codexTurnCeilingHarnessWorkWrapUpTokens: 0, codexTurnCeilingHarnessWorkStopTokens: 0,
  codexTurnCeilingChatsWrapUpTokens: 0, codexTurnCeilingChatsStopTokens: 0,
};

export function readAppSettings(): Partial<CodexTurnCeilingSettings> | undefined {
  try {
    return getSettingsManager().getAll();
  } catch {
    // Electron main: the built-in thresholds still protect a session whose settings cannot be read.
    if (process.versions.electron && (process as NodeJS.Process & { type?: string }).type === 'browser') return undefined;
    // A remote worker has no settings store and receives no snapshot from its controller, and a stop raised there
    // would reach the controller as an ordinary failure that a queue might retry. It applies no round limit.
    return NO_ROUND_LIMITS;
  }
}

/**
 * Adapter-side owner of one Codex round's ceiling. It watches the processed
 * tokens booked by the usage accounting (root plus helper threads), asks Codex
 * to wrap up once, stops the round once for Harness's own work, and records
 * the root/helper share of every round, correcting it (a bounded number of
 * times) when receipts for a finished round arrive late.
 */
export class CodexTurnCeilingController {
  private readonly ceiling: CodexTurnTokenCeiling;
  private pendingStop: HarnessStopError | null = null;
  private live: Round | null = null;
  private retired: Round[] = [];
  private commandModeNoted = false;

  constructor(private readonly host: CodexTurnCeilingHost) {
    // Settings are read when a round begins, so building an adapter never touches the settings store.
    this.ceiling = new CodexTurnTokenCeiling(resolveCodexTurnCeilingPolicy(host.sessionKind(), undefined));
  }

  /** A new round started on the root thread (Harness-started or followed). A repeat of the running round's start changes nothing. */
  beginTurn(turnId: string): void {
    if (this.live?.turnId === turnId) return;
    this.retireLive();
    this.ceiling.setPolicy(this.resolvePolicy());
    this.ceiling.beginTurn(turnId);
    this.pendingStop = null;
    this.live = newRound(turnId, this.host.threadId());
  }

  /**
   * Runs a usage-accounting call and books the processed tokens it added.
   * `late` bookkeeping (round end, rollout reconciliation, trailing receipts)
   * only counts: the round is over and nothing may be steered or interrupted.
   * It is attributed to `turnId` when given, else to the latest round.
   */
  measure<T>(helper: boolean, run: () => T, mode: CodexMeasureMode = 'live', turnId?: string): T {
    const before = this.host.cumulativeTokens();
    const result = run();
    const delta = this.host.cumulativeTokens() - before;
    this.recordMeasuredUsage(helper, delta, mode, turnId);
    return result;
  }

  /** Attribute usage already booked while a helper's parent was still unknown. Never books provider cost twice. */
  recordMeasuredUsage(helper: boolean, delta: number, mode: CodexMeasureMode, turnId?: string): void {
    const round = this.roundFor(turnId);
    if (!round) return;
    if (delta > 0) {
      if (round === this.live) this.ceiling.record(delta, helper);
      else if (helper) round.helperTokens += delta;
      else round.rootTokens += delta;
      if (round.written) this.scheduleWrite(round);
    }
    if (mode === 'live') this.evaluateLiveTurn(round.turnId);
  }

  /** Delayed ownership can cross a threshold without another provider sample. Finished rounds only count. */
  evaluateLiveTurn(turnId: string): void {
    if (this.live?.turnId === turnId && !this.live.finished) this.act(this.ceiling.evaluate());
  }

  /** The stop to report once the interrupted turn has ended, if this round was stopped. */
  consumeStop(): HarnessStopError | null {
    const stop = this.pendingStop;
    this.pendingStop = null;
    return stop;
  }

  /** End enforcement synchronously at capture completion; final receipt publication may still be waiting. */
  endTurn(turnId: string): void {
    const round = this.roundFor(turnId);
    if (round) round.finished = true;
  }

  /**
   * The round's receipts are in: write its share, or schedule a correction
   * when it was already written and has changed since. Tied to the root turn
   * id so a late reconciliation for an earlier round never touches the round
   * that replaced it.
   */
  finishTurn(turnId: string): void {
    const round = this.roundFor(turnId);
    if (!round) return;
    this.endTurn(turnId);
    if (round.written) this.scheduleWrite(round);
    else this.write(round);
  }

  /** Writes anything still pending, at shutdown. */
  flush(): void {
    for (const round of [...this.retired, ...(this.live ? [this.live] : [])]) this.write(round);
  }

  /**
   * Command mode (the `codex exec` fallback, always used for hardened sessions) only learns its token
   * use when a turn ends, so there is nothing live to act on. Say so once, in the log and, for work
   * that promises a stop, in the transcript, instead of letting a configured limit read as
   * protection. Hardened mode and permissions are left exactly as they are.
   */
  noteCommandMode(hardened: boolean): void {
    if (this.commandModeNoted) return;
    this.commandModeNoted = true;
    const policy = this.resolvePolicy();
    if (policy.wrapUpAt <= 0 && policy.stopAt <= 0) return;
    logger.warn('The Codex round token ceiling cannot act in command mode', {
      sessionKind: this.host.sessionKind() ?? 'chat', hardened, wrapUpAt: policy.wrapUpAt, stopAt: policy.stopAt,
    });
    if (policy.stopAt <= 0) return;
    try {
      this.host.emitSystem(COMMAND_MODE_NOTICE, { source: 'codex-turn-ceiling', stage: 'inactive', hardened });
    } catch (error) {
      // A notice must never fail the send it precedes.
      logger.warn('Could not post the command-mode notice', { ...errorDiagnostic(error) });
    }
  }

  private resolvePolicy(): CodexTurnCeilingPolicy {
    return resolveCodexTurnCeilingPolicy(this.host.sessionKind(), (this.host.readSettings ?? readAppSettings)());
  }

  private roundFor(turnId: string | undefined): Round | null {
    if (turnId === undefined) return this.live ?? this.retired.at(-1) ?? null;
    if (this.live?.turnId === turnId) return this.live;
    return this.retired.find((round) => round.turnId === turnId) ?? null;
  }

  private counters(round: Round): { rootTokens: number; helperTokens: number; wrapUpDelivered: boolean; stopRequested: boolean } {
    if (round !== this.live) return round;
    const snapshot = this.ceiling.snapshot();
    return {
      rootTokens: snapshot.rootTokens,
      helperTokens: snapshot.helperTokens,
      wrapUpDelivered: snapshot.wrapUpDelivered,
      stopRequested: snapshot.stopRequested,
    };
  }

  /** Freezes the running round's counters so late receipts can still be attributed to it. */
  private retireLive(): void {
    const round = this.live;
    if (!round) return;
    Object.assign(round, this.counters(round));
    this.live = null;
    this.write(round);
    this.retired.push(round);
    while (this.retired.length > RETAINED_ROUNDS) {
      const oldest = this.retired.shift()!;
      this.write(oldest);
    }
  }

  private scheduleWrite(round: Round): void {
    if (round.timer || round.revision >= MAX_REVISIONS) return;
    round.timer = setTimeout(() => {
      round.timer = null;
      this.write(round);
    }, this.host.correctionDelayMs ?? CORRECTION_DELAY_MS);
    round.timer.unref?.();
  }

  private write(round: Round): void {
    if (round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }
    const counters = this.counters(round);
    const totalTokens = counters.rootTokens + counters.helperTokens;
    const { threadId } = round;
    if (!threadId || totalTokens <= 0 || round.revision >= MAX_REVISIONS) return;
    if (round.written?.rootTokens === counters.rootTokens && round.written.helperTokens === counters.helperTokens
      && round.written.wrapUpDelivered === counters.wrapUpDelivered && round.written.stopRequested === counters.stopRequested) return;
    const { arm, key } = this.host.trial();
    const instanceId = this.host.instanceId?.();
    this.host.publishShare({
      event: 'turn-share',
      provider: 'codex',
      threadId,
      turnId: round.turnId,
      revision: round.revision,
      sessionKind: this.host.sessionKind() ?? 'chat',
      ...(instanceId ? { instanceId } : {}),
      ...(arm ? { arm } : {}),
      ...(key ? { armKey: key } : {}),
      rootTokens: counters.rootTokens,
      helperTokens: counters.helperTokens,
      totalTokens,
      helperShare: counters.helperTokens / totalTokens,
      wrapUpDelivered: counters.wrapUpDelivered,
      stopRequested: counters.stopRequested,
    });
    round.revision += 1;
    round.written = { ...counters };
  }

  private act(action: CodexTurnCeilingAction): void {
    if (action.stop) this.stop();
    else if (action.wrapUp !== null) void this.wrapUp(action.wrapUp);
  }

  private stop(): void {
    const policy = this.ceiling.getPolicy();
    const details: HarnessStopDetails = {
      reason: 'turn-token-ceiling',
      tokens: this.ceiling.snapshot().totalTokens,
      thresholdTokens: policy.stopAt,
    };
    this.pendingStop = new HarnessStopError(details);
    logger.warn('Stopping a Codex round that passed its token ceiling', { ...details, group: policy.group });
    this.host.emitSystem(harnessStopNotice(details), { source: 'codex-turn-ceiling', stage: 'stop', stoppedByHarness: details });
    try {
      this.host.requestStop();
    } catch (error) {
      logger.warn('Codex round stop request failed', { ...errorDiagnostic(error) });
    }
  }

  /** One request at a time, bound to the round that asked: a late answer never touches a newer round. */
  private async wrapUp(claim: number): Promise<void> {
    const round = this.live;
    if (!round) return;
    const wrapUpAt = this.ceiling.getPolicy().wrapUpAt;
    let delivered = false;
    try {
      delivered = await this.host.deliverWrapUp(CODEX_TURN_WRAP_UP_TEXT);
    } catch (error) {
      logger.warn('Codex wrap-up request failed', { ...errorDiagnostic(error) });
    }
    // Acknowledgement belongs to the requesting round, even if completion or
    // replacement overtook it. Never settle a retired claim on the new ceiling.
    if (round !== this.live && !this.retired.includes(round)) return;
    if (round === this.live && !this.ceiling.settleWrapUp(claim, delivered)) return;
    if (!delivered) return;
    round.wrapUpDelivered = true;
    // This one acknowledgement may arrive after shutdown's final flush.
    // Persist it now: an unreferenced correction timer cannot keep the process alive.
    if (round.written) this.write(round);
    if (round !== this.live) return;
    this.host.emitSystem(
      `This turn passed ${formatStopTokens(wrapUpAt)} tokens, so Harness asked Codex to wrap up.`,
      { source: 'codex-turn-ceiling', stage: 'wrap-up', thresholdTokens: wrapUpAt },
    );
  }
}

function newRound(turnId: string, threadId: string | null): Round {
  return { turnId, finished: false, threadId, rootTokens: 0, helperTokens: 0, wrapUpDelivered: false, stopRequested: false, revision: 0, written: null, timer: null };
}

/** Trial identity for the session-policy log: the arm the thread policy already resolved for this session. */
export function codexCeilingTrial(config: { trialArm?: CodexTrialArm; trialKey?: string }): { arm?: CodexTrialArm; key?: string } {
  return { ...(config.trialArm ? { arm: config.trialArm } : {}), ...(config.trialKey ? { key: config.trialKey } : {}) };
}

/** Helpers are separate threads: ending the root turn alone would leave them spending. */
export function interruptHelperTurns(
  state: { completed: boolean; threadId: string; threadTurnIds: ReadonlyMap<string, string>; activeSubagentTurns: ReadonlySet<string> } | null,
  client: { request(method: 'turn/interrupt', params: { threadId: string; turnId: string }): Promise<unknown> } | null,
): void {
  if (!state || state.completed || !client) return;
  for (const [threadId, turnId] of state.threadTurnIds) {
    if (threadId === state.threadId || !state.activeSubagentTurns.has(turnId)) continue;
    client.request('turn/interrupt', { threadId, turnId }).catch((error: unknown) => {
      logger.warn('Could not interrupt a helper turn after the round ceiling', { threadId, ...errorDiagnostic(error) });
    });
  }
}
