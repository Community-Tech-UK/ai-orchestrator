import { describe, expect, it } from 'vitest';

import { loopTerminalNotice } from './loop-terminal-notification';

const base = { iterations: 3, notifyEnabled: true, goal: 'Fix the login flow' } as const;

describe('loopTerminalNotice (N1)', () => {
  it('says nothing while the run is still going', () => {
    for (const status of ['running', 'paused'] as const) {
      expect(loopTerminalNotice({ ...base, status }), status).toBeNull();
    }
  });

  it('reports a clean finish', () => {
    const notice = loopTerminalNotice({ ...base, status: 'completed' });
    expect(notice?.kind).toBe('loop-finished');
    expect(notice?.urgency).toBe('normal');
    expect(notice?.body).toContain('3 iterations');
  });

  it('escalates a run that needs review', () => {
    const notice = loopTerminalNotice({
      ...base,
      status: 'completed-needs-review',
      reason: 'verify passed but the reviewer raised two findings',
    });
    expect(notice?.kind).toBe('loop-needs-you');
    expect(notice?.urgency).toBe('critical');
    expect(notice?.body).toContain('two findings');
  });

  it('escalates every terminal outcome that stopped short of finishing', () => {
    // The first version of this policy kept its own terminal list and silently
    // omitted these three.
    for (const status of ['failed', 'no-progress', 'cap-reached'] as const) {
      const notice = loopTerminalNotice({ ...base, status });
      expect(notice, status).not.toBeNull();
      expect(notice!.urgency, status).toBe('critical');
    }
  });

  it('escalates an error', () => {
    expect(loopTerminalNotice({ ...base, status: 'error', reason: 'boom' })?.urgency)
      .toBe('critical');
  });

  it('does not escalate a cancel, which is usually the operator’s own doing', () => {
    const notice = loopTerminalNotice({ ...base, status: 'cancelled' });
    expect(notice?.urgency).toBe('normal');
    expect(notice?.title).toBe('Loop stopped');
  });

  it('names which loop it is talking about', () => {
    expect(loopTerminalNotice({ ...base, status: 'completed' })?.body)
      .toContain('Fix the login flow');
  });

  it('still reports when there is no goal text', () => {
    const notice = loopTerminalNotice({ ...base, goal: undefined, status: 'completed' });
    expect(notice?.body).toContain('A loop run');
  });

  it('says nothing when the setting is off', () => {
    expect(loopTerminalNotice({ ...base, status: 'completed', notifyEnabled: false })).toBeNull();
    expect(loopTerminalNotice({ ...base, status: 'error', notifyEnabled: false })).toBeNull();
  });

  it('gets the singular right for a one-iteration run', () => {
    expect(loopTerminalNotice({ ...base, iterations: 1, status: 'completed' })?.body)
      .toContain('1 iteration.');
  });

  it('clips a long goal and a long reason rather than shipping a wall of text', () => {
    const notice = loopTerminalNotice({
      ...base,
      goal: 'g'.repeat(300),
      reason: 'r'.repeat(400),
      status: 'error',
    });
    expect(notice!.body.length).toBeLessThan(260);
    expect(notice!.body).toContain('…');
  });

  it('flattens newlines so a multi-line reason stays one readable line', () => {
    const notice = loopTerminalNotice({
      ...base,
      status: 'error',
      reason: 'first line\n\nsecond line',
    });
    expect(notice?.body).toContain('first line second line');
  });
});
