import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { awaitFirstReply, type FirstReplyInstanceSource } from './first-reply-source';

type Session = Pick<Instance, 'status' | 'isRenamed' | 'outputBuffer'>;

function assistant(id: string, content: string): OutputMessage {
  return { id, timestamp: 0, type: 'assistant', content };
}

function sourceFor(session: Session | undefined): FirstReplyInstanceSource {
  return { getInstance: () => session };
}

describe('awaitFirstReply', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns the reply once it says enough, without waiting for the turn to end', async () => {
    const long = 'The screenshot shows session titles built from pasted image names. '.repeat(5);
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    await vi.advanceTimersByTimeAsync(3_000);
    session.outputBuffer = [{ id: 'u', timestamp: 0, type: 'user', content: 'Look into this' }, assistant('a1', long)];
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBe(long.trim());
  });

  it('returns a short reply once the first turn is over', async () => {
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    session.outputBuffer = [assistant('a1', 'The screenshot shows a login error.')];
    let settled = false;
    void reply.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    session.status = 'idle';
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBe('The screenshot shows a login error.');
  });

  it('ignores replies copied in before the wait began, such as a forked session history', async () => {
    const copied = 'An earlier answer about the deploy pipeline. '.repeat(10);
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [assistant('old', copied)] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    await vi.advanceTimersByTimeAsync(1_000);
    session.outputBuffer = [...session.outputBuffer, assistant('new', 'The screenshot shows a login error.')];
    session.status = 'idle';
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBe('The screenshot shows a login error.');
  });

  it('does not take a usage-limit notice or sign-in banner as the reply', async () => {
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    session.outputBuffer = [
      assistant('n1', "You've hit your session limit · resets 6:30pm"),
      assistant('n2', 'Not logged in · Please run /login'),
    ];
    session.status = 'idle';
    let settled = false;
    void reply.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    session.outputBuffer = [...session.outputBuffer, assistant('a1', 'The screenshot shows the login page rejecting a valid postcode.')];
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBe('The screenshot shows the login page rejecting a valid postcode.');
  });

  it('keeps a long reply that only mentions a limit or a login', async () => {
    const long = `The screenshot shows users who are not logged in hitting the rate limit reached page. ${'More detail. '.repeat(30)}`;
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    session.outputBuffer = [assistant('a1', long)];
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBe(long.trim());
  });

  it('gives up with null when the user renames the session or it ends', async () => {
    const renamed: Session = { status: 'busy', isRenamed: true, outputBuffer: [] };
    await expect(awaitFirstReply(sourceFor(renamed), 'i1')).resolves.toBeNull();
    const ended: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(ended), 'i1');
    ended.outputBuffer = [assistant('a1', 'Partial')];
    ended.status = 'terminated';
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toBeNull();
    await expect(awaitFirstReply(sourceFor(undefined), 'i1')).resolves.toBeNull();
  });

  it('stops waiting after five minutes with whatever reply there is', async () => {
    const session: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const reply = awaitFirstReply(sourceFor(session), 'i1');
    session.outputBuffer = [assistant('a1', 'Looking at the screenshot.')];
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    await expect(reply).resolves.toBe('Looking at the screenshot.');

    const silent: Session = { status: 'busy', isRenamed: false, outputBuffer: [] };
    const none = awaitFirstReply(sourceFor(silent), 'i2');
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
    await expect(none).resolves.toBeNull();
  });
});
