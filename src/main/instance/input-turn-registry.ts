/**
 * Which turn a person's message started, and whether any other turn has started since.
 *
 * Plan Queue lets a run's parent session land work without a passing check only
 * in its reply to a message a person typed after the item parked
 * (docs/plans/2026-11-04-pq-b1-land-anyway_plan.md, Decision 6). Three facts
 * decide it, and this registry keeps the two that need memory of the session:
 *
 *   - the latest input of any kind is that message. Every send passes through
 *     `InstanceManager.sendInput`, which reports each one here, so an automation
 *     prompt, another agent's message, a steer or a Harness notice written after
 *     the person's message replaces it as the latest input. The exception is
 *     anything the Plan Queue sends a session about a run it owns (the run summary,
 *     a question, a capability-repair handoff), which the sender announces with
 *     `expectNotice`: it is the queue reporting on the run, so once the person's message has started its turn
 *     the report leaves that message in place. Before then it replaces it like
 *     any input, and if it starts a turn of its own the count below refuses;
 *   - no other turn has started since. Adapters report each turn start
 *     (`turn_started`) and say who started it: a message Harness sent
 *     (`harness-send`) or the provider itself (`provider`: a Claude CLI turn begun
 *     by a background job's end, a Codex goal turn). Only a `harness-send` start
 *     can be the turn the person's message started; a `provider` start never is,
 *     even when it arrives first (it also ends the message's wait, so nothing binds
 *     after it), and both raise the count. When the person's
 *     turn begins, the count at that moment is kept with the message and the call
 *     is allowed only while the count still equals it.
 *
 * A provider whose adapter cannot report turn starts is refused. Nothing here is
 * saved: after a restart every session starts with no message, so a person has to
 * send a new one first, even though the stored message still carries its origin.
 */

import type { TurnStartedEvent } from '../cli/adapters/base-cli-adapter.types';

export type TurnStartSource = TurnStartedEvent['source'];

/** A turn that starts later than this after the input is not taken to be the input's own turn. */
const BIND_WINDOW_MS = 2 * 60_000;

export type PersonTurnRefusal =
  | 'provider-cannot-report'
  | 'no-input'
  | 'latest-input-not-person'
  | 'turn-not-started'
  | 'another-turn-started';

export type PersonTurnCheck =
  | { ok: true; messageId: string; typedAt: number }
  | { ok: false; reason: PersonTurnRefusal };

interface LatestInput {
  messageId: string;
  /** Set when the person typed or spoke it, with the time they did. */
  personTypedAt: number | null;
  recordedAt: number;
  /** Cleared when its turn starts, or when sending it failed. */
  awaitingTurn: boolean;
}

interface SessionInputState {
  reportsTurnStarts: boolean;
  turnCount: number;
  latestInput: LatestInput | null;
  /** The turn the person's latest message started, and the count when it began. */
  personTurn: { messageId: string; countAtStart: number } | null;
  /** Queue reports announced by `expectNotice` and not yet sent. */
  notices: Set<string>;
}

export class InputTurnRegistry {
  private static instance: InputTurnRegistry | null = null;
  private readonly sessions = new Map<string, SessionInputState>();

  constructor(private readonly now: () => number = Date.now) {}

  static getInstance(): InputTurnRegistry {
    InputTurnRegistry.instance ??= new InputTurnRegistry();
    return InputTurnRegistry.instance;
  }

  static _resetForTesting(): void {
    InputTurnRegistry.instance = null;
  }

  /** Whether this session's adapter reports turn starts; set each time an adapter is attached. */
  setReportsTurnStarts(instanceId: string, reports: boolean): void {
    this.session(instanceId).reportsTurnStarts = reports;
  }

  /** The message with this id, when sent, is a Plan Queue report about the session's own run and does not replace its latest input. */
  expectNotice(instanceId: string, messageId: string): void {
    this.session(instanceId).notices.add(messageId);
  }

  /** The announced report was never sent. */
  dropNotice(instanceId: string, messageId: string): void {
    this.sessions.get(instanceId)?.notices.delete(messageId);
  }

  /** Every other input to the session, of any kind, becomes its latest input. */
  noteInput(instanceId: string, input: { messageId: string; personTypedAt: number | null }): void {
    const state = this.session(instanceId);
    // A report counts as a report only once the person's message has started its own turn; before that, the report's
    // turn could start first and be taken for the person's, so it replaces the message as any other input does.
    const personTurnBegun = state.latestInput !== null && state.personTurn?.messageId === state.latestInput.messageId;
    if (state.notices.delete(input.messageId) && personTurnBegun) return;
    state.latestInput = {
      messageId: input.messageId,
      personTypedAt: input.personTypedAt,
      recordedAt: this.now(),
      awaitingTurn: input.personTypedAt !== null,
    };
  }

  /** The send failed, so no turn will start from it. */
  noteInputFailed(instanceId: string, messageId: string): void {
    const state = this.sessions.get(instanceId);
    if (state?.latestInput?.messageId === messageId) state.latestInput.awaitingTurn = false;
  }

  /**
   * An adapter reported that a turn started. Every start is counted. A turn the provider started
   * itself is never the person's message's turn, and once one arrives while the message is waiting
   * for its turn the message can no longer be told apart from it, so the wait ends with no binding
   * (the call stays refused until a new message). Only a `harness-send` start binds.
   */
  noteTurnStarted(instanceId: string, source: TurnStartSource): void {
    const state = this.session(instanceId);
    state.turnCount += 1;
    const input = state.latestInput;
    if (!input?.awaitingTurn) return;
    input.awaitingTurn = false;
    if (source === 'harness-send' && this.now() - input.recordedAt <= BIND_WINDOW_MS) {
      state.personTurn = { messageId: input.messageId, countAtStart: state.turnCount };
    }
  }

  /** Whether the session's current turn is the one a person's latest message started and nothing else has started since. */
  checkPersonTurn(instanceId: string): PersonTurnCheck {
    const state = this.sessions.get(instanceId);
    if (!state?.reportsTurnStarts) return { ok: false, reason: 'provider-cannot-report' };
    const input = state.latestInput;
    if (!input) return { ok: false, reason: 'no-input' };
    if (input.personTypedAt === null) return { ok: false, reason: 'latest-input-not-person' };
    if (state.personTurn?.messageId !== input.messageId) return { ok: false, reason: 'turn-not-started' };
    if (state.turnCount !== state.personTurn.countAtStart) return { ok: false, reason: 'another-turn-started' };
    return { ok: true, messageId: input.messageId, typedAt: input.personTypedAt };
  }

  forget(instanceId: string): void {
    this.sessions.delete(instanceId);
  }

  private session(instanceId: string): SessionInputState {
    let state = this.sessions.get(instanceId);
    if (!state) {
      state = { reportsTurnStarts: false, turnCount: 0, latestInput: null, personTurn: null, notices: new Set<string>() };
      this.sessions.set(instanceId, state);
    }
    return state;
  }
}

export function getInputTurnRegistry(): InputTurnRegistry {
  return InputTurnRegistry.getInstance();
}
