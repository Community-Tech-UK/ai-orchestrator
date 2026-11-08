import { beforeEach, describe, expect, it } from 'vitest';
import { getInputTurnRegistry, InputTurnRegistry } from './input-turn-registry';

const S = 'session-1';
let clock = 1_000_000;
let registry: InputTurnRegistry;

beforeEach(() => {
  clock = 1_000_000;
  registry = new InputTurnRegistry(() => clock);
  registry.setReportsTurnStarts(S, true);
});

/** A person's message that has started its turn. */
function personTurn(messageId = 'm1', typedAt = 5_000): void {
  registry.noteInput(S, { messageId, personTypedAt: typedAt });
  registry.noteTurnStarted(S, 'harness-send');
}

describe('InputTurnRegistry.checkPersonTurn', () => {
  it('accepts a person message whose turn has begun, with nothing since', () => {
    personTurn('m1', 5_000);
    expect(registry.checkPersonTurn(S)).toEqual({ ok: true, messageId: 'm1', typedAt: 5_000 });
  });

  it('refuses a provider whose adapter cannot report turn starts', () => {
    registry.setReportsTurnStarts(S, false);
    personTurn();
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'provider-cannot-report' });
  });

  it('refuses a session it has never seen (after a restart nothing is remembered)', () => {
    expect(new InputTurnRegistry().checkPersonTurn(S)).toEqual({ ok: false, reason: 'provider-cannot-report' });
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'no-input' });
  });

  it('refuses when a later input of any other kind replaced the message', () => {
    personTurn();
    registry.noteInput(S, { messageId: 'notice', personTypedAt: null }); // queue notice, automation, other agent, packet, steer
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'latest-input-not-person' });
    registry.noteTurnStarted(S, 'harness-send');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'latest-input-not-person' });
  });

  it('refuses while the person message has not yet started a turn', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
  });

  it('refuses a message whose send failed, even if an unrelated turn starts afterwards', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    registry.noteInputFailed(S, 'm1');
    registry.noteTurnStarted(S, 'harness-send');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
  });

  it('refuses once another turn starts with no new input (background job ended, goal turn)', () => {
    personTurn();
    registry.noteTurnStarted(S, 'provider');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'another-turn-started' });
  });

  it('refuses while only a turn the provider started itself has begun after the message', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    registry.noteTurnStarted(S, 'provider'); // a background job ended just before the message's own turn
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
  });

  it('does not bind a later turn once a provider turn has come between the message and it', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    registry.noteTurnStarted(S, 'provider');
    registry.noteTurnStarted(S, 'harness-send'); // may be the message's turn, may not: it cannot be told
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
  });

  it('binds again to the next message once a provider turn has been and gone', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    registry.noteTurnStarted(S, 'provider');
    registry.noteInput(S, { messageId: 'm2', personTypedAt: 6_000 });
    registry.noteTurnStarted(S, 'harness-send');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: true, messageId: 'm2', typedAt: 6_000 });
  });

  it('does not bind a turn that starts long after the message was sent', () => {
    registry.noteInput(S, { messageId: 'm1', personTypedAt: 5_000 });
    clock += 5 * 60_000;
    registry.noteTurnStarted(S, 'harness-send');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
  });

  it('a newer person message needs its own turn', () => {
    personTurn('m1');
    registry.noteInput(S, { messageId: 'm2', personTypedAt: 6_000 });
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'turn-not-started' });
    registry.noteTurnStarted(S, 'harness-send');
    expect(registry.checkPersonTurn(S)).toEqual({ ok: true, messageId: 'm2', typedAt: 6_000 });
  });

  it('keeps sessions apart and forgets a removed one', () => {
    personTurn();
    registry.setReportsTurnStarts('other', true);
    expect(registry.checkPersonTurn('other')).toEqual({ ok: false, reason: 'no-input' });
    registry.forget(S);
    expect(registry.checkPersonTurn(S)).toEqual({ ok: false, reason: 'provider-cannot-report' });
  });

  it('is a resettable singleton', () => {
    const first = getInputTurnRegistry();
    expect(getInputTurnRegistry()).toBe(first);
    InputTurnRegistry._resetForTesting();
    expect(getInputTurnRegistry()).not.toBe(first);
  });
});
