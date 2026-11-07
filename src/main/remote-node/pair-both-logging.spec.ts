import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as { level: string; message: string; data: Record<string, unknown> }[]);

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: (message: string, data: Record<string, unknown>) => calls.push({ level: 'info', message, data }),
    warn: (message: string, data: Record<string, unknown>) => calls.push({ level: 'warn', message, data }),
  }),
}));

import { pairBothLog } from './pair-both-logging';
import { capForLog } from './pair-both-rendezvous-helpers';

const session = { sessionId: 'session-1', status: 'confirming' };

describe('pairBothLog', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('adds the session id and status to info and warn lines', () => {
    pairBothLog.info('one', session, { port: 4878 });
    pairBothLog.warn('two', session);
    expect(calls).toEqual([
      { level: 'info', message: 'one', data: { sessionId: 'session-1', status: 'confirming', port: 4878 } },
      { level: 'warn', message: 'two', data: { sessionId: 'session-1', status: 'confirming' } },
    ]);
  });

  it('logs only the given fields when there is no session', () => {
    pairBothLog.info('none', null, { remoteAddress: '192.168.0.4' });
    pairBothLog.info('undefined', undefined);
    expect(calls.map((call) => call.data)).toEqual([{ remoteAddress: '192.168.0.4' }, {}]);
  });

  it('logs a close with its code and a one-line close reason of at most 200 characters', () => {
    pairBothLog.closed('closed', session, 1008, Buffer.from(`${'x'.repeat(300)}\nsecond line`), { remoteAddress: '::1' });
    const { data } = calls[0];
    expect(data).toMatchObject({ sessionId: 'session-1', code: 1008, remoteAddress: '::1' });
    expect(String(data['reason'])).not.toMatch(/[\r\n]/);
    expect(String(data['reason']).length).toBeLessThanOrEqual(203);
  });

  it('does not add anything the caller did not pass, so a session never leaks its code or keys', () => {
    // The session shape only has id and status; extra properties on a full state are ignored.
    const fullState = { ...session, shortCode: '123 456', coordinatorHello: { publicKey: 'PUBLIC_KEY_VALUE' } };
    pairBothLog.info('state', fullState);
    expect(JSON.stringify(calls)).not.toContain('123 456');
    expect(JSON.stringify(calls)).not.toContain('PUBLIC_KEY_VALUE');
  });
});

describe('capForLog', () => {
  it('collapses line breaks and tabs into single spaces', () => {
    expect(capForLog('a\r\nb\tc\n')).toBe('a b c');
  });

  it('cuts text longer than 200 characters', () => {
    expect(capForLog('y'.repeat(500))).toBe(`${'y'.repeat(200)}...`);
    expect(capForLog('y'.repeat(200))).toBe('y'.repeat(200));
  });

  it('turns missing text into an empty string', () => {
    expect(capForLog(undefined)).toBe('');
  });
});
