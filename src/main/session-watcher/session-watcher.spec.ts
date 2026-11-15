import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceAnnounceThenHaltContinuationHost } from '../instance/instance-announce-then-halt-continuation';
import { InstanceAsyncWorkRegistry } from '../instance/instance-async-work-registry';
import { InstanceContinuationDispatch } from '../instance/instance-continuation-dispatch';
import { SessionWatcher, type SessionWatcherDeps, type WatcherFlag, type WatcherOutcomeEvent } from './session-watcher';
import { _resetWatcherDecisionLogForTesting } from './watcher-decision-log';
import { routeFinishedNotice } from './watcher-notices';
import type { WatcherLevel } from './watcher-post-checks';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

const QUESTION = 'Shall I carry on with phase 2?';
const verdictJson = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  verdict: 'carry_on', stop: 'asked_to_continue', basis: 'planned_work', quote: '', question: QUESTION, reason: 'Planned.', ...overrides,
});

describe('SessionWatcher', () => {
  let events: EventEmitter;
  let instance: Instance;
  let host: InstanceAnnounceThenHaltContinuationHost;
  let dispatch: InstanceContinuationDispatch;
  let watcher: SessionWatcher;
  let sent: string[];
  let flags: WatcherFlag[];
  let cleared: string[];
  let outcomes: WatcherOutcomeEvent[];
  let level: WatcherLevel | 'off';
  let typing: boolean;
  let paused: boolean;
  let hasOpenRequest: () => boolean;
  let judgeCalls: { signal: AbortSignal; resolve: (raw: string) => void; reject: (error: Error) => void }[];
  let logDirectory: string;
  let clock = 0;

  const message = (type: OutputMessage['type'], content: string, metadata?: OutputMessage['metadata']): OutputMessage =>
    ({ id: `m${clock += 1}`, timestamp: clock, type, content, ...(metadata ? { metadata } : {}) });
  const typed = (content: string): OutputMessage => message('user', content, { inputOrigin: { kind: 'person', typedAt: clock } });
  const conversation = (reply = `Phase 1 is finished and the tests pass.\n\n${QUESTION}`): OutputMessage[] =>
    [typed('Build the export in three phases.'), message('tool_use', '', { name: 'Bash' }), message('assistant', reply)];

  function complete(event: Record<string, unknown> = {}): void {
    events.emit('provider:normalized-event', {
      eventId: 'e', seq: 1, timestamp: Date.now(), instanceId: 'root', provider: 'claude',
      event: { kind: 'complete', requestCountAtCompletion: instance.requestCount, ...event },
    } as unknown as ProviderRuntimeEventEnvelope);
  }
  /** Waits for the judge to be asked, then answers. */
  async function answer(raw: string, index = 0): Promise<void> {
    await vi.waitFor(() => expect(judgeCalls.length).toBeGreaterThan(index));
    judgeCalls[index].resolve(raw);
  }
  const settled = (): Promise<void> => vi.waitFor(() => expect(outcomes.length).toBeGreaterThan(0));
  function routeFinishedNoticeSafely(): { finished: number; needsYou: WatcherFlag[] } {
    const seen = { finished: 0, needsYou: [] as WatcherFlag[] };
    routeFinishedNotice('root', { finished: () => { seen.finished += 1; }, needsYou: (flag) => { seen.needsYou.push(flag); } });
    return seen;
  }
  const logRows = (): Record<string, unknown>[] => readdirSync(logDirectory)
    .flatMap((file) => readFileSync(join(logDirectory, file), 'utf8').trim().split('\n'))
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);

  beforeEach(() => {
    logDirectory = mkdtempSync(join(tmpdir(), 'session-watcher-'));
    process.env['AIO_SESSION_WATCHER_DIR'] = logDirectory;
    _resetWatcherDecisionLogForTesting();
    events = new EventEmitter();
    instance = {
      id: 'root', parentId: null, childrenIds: [], launchMode: 'orchestrated', provider: 'claude', sessionId: 's', adapterGeneration: 1,
      status: 'idle', requestCount: 3, metadata: {}, planMode: { enabled: false, state: 'off' }, outputBuffer: conversation(),
    } as unknown as Instance;
    sent = []; flags = []; cleared = []; outcomes = []; judgeCalls = [];
    const adapter = {};
    level = 'own-suggestions';
    typing = false;
    paused = false;
    hasOpenRequest = () => false;
    host = {
      on: events.on.bind(events), off: events.off.bind(events), getInstance: (id: string) => (id === 'root' ? instance : undefined),
      getAdapter: () => adapter, emitSystemMessage: vi.fn(), waitForInstanceSettled: async () => instance,
      sendInput: async (_id, prompt, _attachments, options) => {
        events.emit('instance:input-started', { instanceId: 'root', autoContinuation: true });
        options?.beforeProviderDispatch?.();
        instance.requestCount += 1;
        sent.push(prompt);
      },
    } as InstanceAnnounceThenHaltContinuationHost;
    dispatch = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), host);
    dispatch.start();
    const deps: SessionWatcherDeps = {
      level: () => level, isLoopChat: () => false, isSideChat: () => false, isPaused: () => paused,
      hasInhibitor: () => false, hasOpenRequest: () => hasOpenRequest(), isUserTyping: () => typing,
      judge: {
        available: () => true,
        judge: (_prompt, _instanceId, signal) => new Promise((resolve, reject) => {
          const call = {
            signal,
            resolve: (raw: string) => resolve({ raw, provider: 'claude', model: 'haiku', latencyMs: 5 }),
            reject,
          };
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          judgeCalls.push(call);
        }),
      },
    };
    watcher = new SessionWatcher(host, dispatch, deps);
    watcher.on('flag', (flag: WatcherFlag) => flags.push(flag));
    watcher.on('clear', (id: string) => cleared.push(id));
    watcher.on('outcome', (outcome: WatcherOutcomeEvent) => outcomes.push(outcome));
    watcher.start();
  });
  afterEach(() => {
    watcher.stop();
    dispatch.stop();
    delete process.env['AIO_SESSION_WATCHER_DIR'];
    rmSync(logDirectory, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it('lets the rule-based answer through only where its own replies could go', () => {
    expect(watcher.allowsRuleReply(instance)).toBe(true);
    for (const quiet of ['off', 'flag-only'] as const) {
      level = quiet;
      expect(watcher.allowsRuleReply(instance)).toBe(false);
    }
    level = 'planned-work';
    expect(watcher.allowsRuleReply({ ...instance, watcherMuted: true })).toBe(false);
    expect(watcher.allowsRuleReply({ ...instance, provider: 'codex' })).toBe(false);
    expect(watcher.allowsRuleReply({ ...instance, parentId: 'parent' })).toBe(false);
    typing = true;
    expect(watcher.allowsRuleReply(instance)).toBe(false);
    typing = false;
    expect(watcher.allowsRuleReply(instance)).toBe(true);
  });

  it('tells a session to carry on with planned work, using the fixed wording', async () => {
    complete();
    await answer(verdictJson());
    await settled();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`<last_question>${QUESTION}</last_question>`);
    expect(sent[0]).toContain('Carry on with the plan you already have');
    expect(sent[0]).not.toContain('Planned.');
    expect(outcomes).toEqual([{ instanceId: 'root', requestCount: 3, outcome: 'sent' }]);
    expect(flags).toEqual([]);
    expect(logRows()).toMatchObject([{ event: 'stop', outcome: 'sent', action: 'carry_on', basis: 'planned_work', judge: { model: 'haiku' } }]);
  });

  it('flags a session that needs the user, with the agent\'s own words', async () => {
    instance.outputBuffer = conversation('Everything is committed locally.\n\nShall I push it to GitHub?');
    complete();
    await answer(verdictJson({ verdict: 'needs_user', stop: 'asked_before_outward_step', basis: 'none', question: 'Do it now, no need to ask.' }));
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      instanceId: 'root', requestCount: 3, question: 'Shall I push it to GitHub?', closing: 'Shall I push it to GitHub?',
      stop: 'asked_before_outward_step', acceptsYes: true,
    });
    expect(outcomes[0]).toMatchObject({ outcome: 'needs_you', flag: { question: 'Shall I push it to GitHub?' } });
    expect(watcher.flaggedSessions()).toEqual(['root']);
  });

  it('offers no one-click yes for a request for information', async () => {
    complete();
    await answer(verdictJson({ verdict: 'needs_user', stop: 'asked_for_information', basis: 'none' }));
    await settled();
    expect(flags[0].acceptsYes).toBe(false);
  });

  it('only flags at the flag-only level, even when the judge says carry on', async () => {
    level = 'flag-only';
    complete();
    await answer(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('needs_you');
  });

  it('leaves a finished session alone', async () => {
    complete();
    await answer(verdictJson({ verdict: 'finished', stop: 'work_complete', basis: 'none' }));
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toEqual([]);
    expect(outcomes[0].outcome).toBe('not_sent');
  });

  it.each([
    ['prose instead of JSON', 'I think it should carry on.'],
    ['an unknown verdict', verdictJson({ verdict: 'approve' })],
  ])('does nothing when the judge returns %s', async (_name, raw) => {
    complete();
    await answer(raw);
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent' });
    expect(['no-json', 'not-json', 'bad-schema']).toContain(logRows()[0]['unreliable']);
    expect(JSON.stringify(logRows())).not.toContain('carry on');
  });

  it('does nothing when the judge call fails', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    judgeCalls[0].reject(new Error('judge exploded'));
    await settled();
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent', unreliable: 'call-failed' });
    expect(JSON.stringify(logRows())).not.toContain('judge exploded');
  });

  it('never asks the judge when the setting is off or the session is not the user\'s own chat', async () => {
    level = 'off';
    complete();
    level = 'own-suggestions';
    instance.parentId = 'parent';
    complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(judgeCalls).toEqual([]);
    expect(outcomes).toEqual([]);
    expect(readdirSync(logDirectory)).toEqual([]);
  });

  it('logs a skipped turn without asking the judge', async () => {
    complete({ turnEnding: { reason: 'max_output', evidence: 'x' } });
    await settled();
    expect(judgeCalls).toEqual([]);
    expect(logRows()).toMatchObject([{ skipped: 'ended-max_output', outcome: 'not_sent' }]);
  });

  it('skips an error notice instead of judging it', async () => {
    instance.outputBuffer = conversation('API Error: 529 overloaded');
    complete();
    await settled();
    expect(judgeCalls).toEqual([]);
    expect(logRows()[0]).toMatchObject({ skipped: 'error-notice' });
  });

  it('drops the verdict when the user sends a message while the judge is running', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
    instance.requestCount += 1;
    expect(judgeCalls[0].signal.aborted).toBe(true);
    judgeCalls[0].resolve(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(outcomes).toEqual([{ instanceId: 'root', requestCount: 3, outcome: 'not_sent' }]);
    expect(logRows()[0]).toMatchObject({ outcomeReason: 'new-input' });
  });

  it('drops the verdict when Stop is pressed while the judge is running', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    events.emit('instance:interrupt-requested', { instanceId: 'root' });
    await settled();
    expect(judgeCalls[0].signal.aborted).toBe(true);
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcomeReason: 'stopped' });
  });

  it('does not reply when the session changed state while the judge ran', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    instance.status = 'hibernated';
    judgeCalls[0].resolve(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent', outcomeReason: 'asleep' });
  });

  it('judges one finished turn once, even if it is reported twice', async () => {
    complete();
    complete();
    await answer(verdictJson());
    await settled();
    expect(judgeCalls).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('holds its reply while the user is typing, and sends it once they stop', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typing = true;
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    judgeCalls[0].resolve(verdictJson());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sent).toEqual([]);
    typing = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(sent).toHaveLength(1);
  });

  it('gives up on a held reply when the user sends their message', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typing = true;
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    judgeCalls[0].resolve(verdictJson());
    await vi.advanceTimersByTimeAsync(2_000);
    events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
    typing = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    expect(outcomes).toEqual([{ instanceId: 'root', requestCount: 3, outcome: 'not_sent' }]);
  });

  it.each([
    ['the session is muted', () => { instance.watcherMuted = true; }, 'not-covered'],
    ['the setting is switched off', () => { level = 'off'; }, 'not-covered'],
    ['the setting is lowered to flag-only', () => { level = 'flag-only'; }, 'level-lowered'],
  ])('does not send a held reply once %s', async (_name, change, reason) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    typing = true;
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    judgeCalls[0].resolve(verdictJson());
    await vi.advanceTimersByTimeAsync(2_000);
    change();
    typing = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent', outcomeReason: reason });
  });

  it('does not send when the session is muted while the dispatch waits for it to settle', async () => {
    let release!: () => void;
    host.waitForInstanceSettled = () => new Promise((resolve) => { release = () => resolve(instance); });
    complete();
    await answer(verdictJson());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    instance.watcherMuted = true;
    release();
    await settled();
    expect(sent).toEqual([]);
    expect(outcomes[0].outcome).toBe('not_sent');
  });

  it('does not judge a turn again when it is reported a second time after the first was dealt with', async () => {
    complete();
    await answer(verdictJson({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none' }));
    await settled();
    complete();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(judgeCalls).toHaveLength(1);
    expect(flags).toHaveLength(1);
  });

  it('redacts a secret in the agent\'s words before flagging', async () => {
    const secret = 'sk-ant-api03-' + 'A1b2C3d4E5f6G7h8'.repeat(6);
    instance.outputBuffer = conversation(`The key is ${secret}.\n\nShall I store ${secret} in the settings file?`);
    complete();
    await answer(verdictJson({ verdict: 'needs_user', stop: 'asked_to_continue', basis: 'none', question: '' }));
    await settled();
    expect(flags[0].question).not.toContain(secret);
    expect(flags[0].closing).not.toContain(secret);
    expect(flags[0].question).toContain('Shall I store');
  });

  it('drops the first job when a newer turn finishes before its verdict', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    instance.requestCount += 1;
    instance.outputBuffer = [...instance.outputBuffer, message('tool_use', '', { name: 'Bash' }), message('assistant', `More done.\n\n${QUESTION}`)];
    complete();
    expect(judgeCalls[0].signal.aborted).toBe(true);
    expect(logRows()[0]).toMatchObject({ requestCount: 3, outcomeReason: 'superseded' });
    await answer(verdictJson(), 1);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(outcomes.map((o) => [o.requestCount, o.outcome])).toEqual([[3, 'not_sent'], [4, 'sent']]);
  });

  it('lets the dispatch cancel a reply when Stop is pressed while it waits to send', async () => {
    let release!: () => void;
    host.waitForInstanceSettled = () => new Promise((resolve) => { release = () => resolve(instance); });
    complete();
    await answer(verdictJson());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    events.emit('instance:interrupt-requested', { instanceId: 'root' });
    release();
    await settled();
    expect(sent).toEqual([]);
    expect(outcomes).toEqual([{ instanceId: 'root', requestCount: 3, outcome: 'not_sent' }]);
    expect(logRows().filter((row) => row['event'] === 'stop')).toHaveLength(1);
  });

  it.each(['hibernating', 'waking'] as const)('does not reply to a session that is %s when the verdict arrives', async (status) => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    instance.status = status;
    judgeCalls[0].resolve(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcomeReason: 'asleep' });
  });

  it('does not reply when the session moved to another provider while the judge ran', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    instance.provider = 'codex';
    judgeCalls[0].resolve(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent', outcomeReason: 'not-covered' });
  });

  it('does not reply or flag when Harness was paused while the judge ran', async () => {
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    paused = true;
    judgeCalls[0].resolve(verdictJson());
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcomeReason: 'paused' });
  });

  it('reports not sent when the dispatch revokes the reply before it goes out', async () => {
    let release!: () => void;
    host.waitForInstanceSettled = () => new Promise((resolve) => { release = () => resolve(instance); });
    complete();
    await answer(verdictJson());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    dispatch.observeEnding('root', { reason: 'completed', evidence: 'repeated' });
    release();
    await settled();
    expect(sent).toEqual([]);
    expect(logRows()[0]).toMatchObject({ outcome: 'not_sent', outcomeReason: 'dispatch-refused' });
  });

  it('keeps the provider event bus safe when a gate throws, and still lets the finished notice out', async () => {
    hasOpenRequest = () => { throw new Error('store unavailable'); };
    expect(() => complete()).not.toThrow();
    expect(logRows()[0]).toMatchObject({ skipped: 'gate-error', outcome: 'not_sent' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const seen = routeFinishedNoticeSafely();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toEqual({ finished: 1, needsYou: [] });
  });

  it('ignores a late report of an earlier turn, then judges the real one', async () => {
    complete({ requestCountAtCompletion: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcomes).toEqual([]);
    expect(readdirSync(logDirectory)).toEqual([]);
    complete();
    await answer(verdictJson());
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('does not send when the user starts typing while the dispatch waits for the session to settle', async () => {
    let release!: () => void;
    host.waitForInstanceSettled = () => new Promise((resolve) => { release = () => resolve(instance); });
    complete();
    await answer(verdictJson());
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    typing = true;
    release();
    await settled();
    expect(sent).toEqual([]);
  });

  it('flags a push ask that is followed by a closing pleasantry, whatever the judge says', async () => {
    instance.outputBuffer = conversation('Everything is staged.\n\nShall I commit and push? Let me know.');
    complete();
    await answer(verdictJson({ basis: 'own_proposal', question: 'Let me know.' }));
    await settled();
    expect(sent).toEqual([]);
    expect(flags).toHaveLength(1);
    expect(logRows()[0]).toMatchObject({ action: 'needs_user', override: 'risk-last-sentence' });
  });

  it('gives up at the backstop and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    complete();
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(151_000);
    expect(judgeCalls[0].signal.aborted).toBe(true);
    expect(outcomes).toEqual([{ instanceId: 'root', requestCount: 3, outcome: 'not_sent' }]);
  });

  it('hands back after ten automatic replies in a row', async () => {
    for (let round = 0; round < 10; round += 1) {
      instance.outputBuffer = [...instance.outputBuffer, message('tool_use', '', { name: 'Bash' }), message('assistant', `Step ${round} done.\n\n${QUESTION}`)];
      complete();
      await answer(verdictJson(), round);
      await vi.waitFor(() => expect(sent).toHaveLength(round + 1));
    }
    instance.outputBuffer = [...instance.outputBuffer, message('tool_use', '', { name: 'Bash' }), message('assistant', `Step 10 done.\n\n${QUESTION}`)];
    complete();
    await answer(verdictJson(), 10);
    await vi.waitFor(() => expect(flags).toHaveLength(1));
    expect(sent).toHaveLength(10);
    expect(flags[0]).toMatchObject({ note: 'Kept going 10 times in a row. Check it is on track.', acceptsYes: false });
  });

  it('clears the flag when the session gets any input, and when it is removed', async () => {
    complete();
    await answer(verdictJson({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none' }));
    await settled();
    events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
    expect(cleared).toEqual(['root']);
    expect(watcher.flaggedSessions()).toEqual([]);
    events.emit('instance:removed', 'root');
    expect(cleared).toEqual(['root']);
  });

  describe('finished notices', () => {
    const route = (): { finished: number; needsYou: WatcherFlag[] } => {
      const seen = { finished: 0, needsYou: [] as WatcherFlag[] };
      routeFinishedNotice('root', { finished: () => { seen.finished += 1; }, needsYou: (flag) => { seen.needsYou.push(flag); } });
      return seen;
    };
    const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

    it('sends nothing for a stop the watcher carried on', async () => {
      complete();
      const seen = route();
      await answer(verdictJson());
      await settled();
      await tick();
      expect(seen).toEqual({ finished: 0, needsYou: [] });
    });

    it('says the session needs the user, once, with the agent\'s question', async () => {
      complete();
      const seen = route();
      await answer(verdictJson({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none' }));
      await settled();
      await tick();
      expect(seen.finished).toBe(0);
      expect(seen.needsYou).toHaveLength(1);
      expect(seen.needsYou[0].question).toBe(QUESTION);
    });

    it.each([
      ['a finished verdict', verdictJson({ verdict: 'finished', stop: 'work_complete', basis: 'none' })],
      ['an unusable verdict', 'no idea'],
    ])('sends the usual finished notice after %s', async (_name, raw) => {
      complete();
      const seen = route();
      await answer(raw);
      await settled();
      await tick();
      expect(seen).toEqual({ finished: 1, needsYou: [] });
    });

    it('sends the usual notice when the reply could not be delivered', async () => {
      host.sendInput = async () => { throw new Error('send failed'); };
      complete();
      const seen = route();
      await answer(verdictJson());
      await settled();
      await tick();
      expect(sent).toEqual([]);
      expect(seen).toEqual({ finished: 1, needsYou: [] });
    });

    it('works when the idle change arrives after the outcome', async () => {
      complete({ turnEnding: { reason: 'max_output', evidence: 'x' } });
      await settled();
      const seen = route();
      await tick();
      expect(seen).toEqual({ finished: 1, needsYou: [] });
    });

    it('stays silent for both senders when the idle change arrives after the carry-on has already gone out', async () => {
      complete();
      await answer(verdictJson());
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      const desktop = route();
      const phone = route();
      await tick();
      expect(desktop).toEqual({ finished: 0, needsYou: [] });
      expect(phone).toEqual({ finished: 0, needsYou: [] });
    });

    it('is not thrown off by a late second report of the carried-on stop', async () => {
      complete();
      const first = route();
      await answer(verdictJson());
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      complete({ requestCountAtCompletion: 3 });
      await new Promise((resolve) => setTimeout(resolve, 600));
      instance.outputBuffer = [...instance.outputBuffer, message('assistant', 'All three phases are done.')];
      const second = route();
      complete();
      await answer(verdictJson({ verdict: 'finished', stop: 'work_complete', basis: 'none' }), 1);
      await vi.waitFor(() => expect(second.finished).toBe(1));
      expect(first).toEqual({ finished: 0, needsYou: [] });
      expect(second.needsYou).toEqual([]);
    });

    it('announces the carried-on turn itself when it ends quickly', async () => {
      complete();
      const first = route();
      await answer(verdictJson());
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      await tick();
      expect(first).toEqual({ finished: 0, needsYou: [] });
      // The carry-on turn answers in one line and stops; its idle change arrives before its completion event.
      // Even the shortest real turn takes longer than the window in which two senders count as one idle change.
      await new Promise((resolve) => setTimeout(resolve, 600));
      instance.outputBuffer = [...instance.outputBuffer, message('assistant', 'Which of the two layouts do you want?')];
      const second = route();
      complete();
      await answer(verdictJson({ verdict: 'needs_user', stop: 'asked_for_information', basis: 'none' }), 1);
      await vi.waitFor(() => expect(second.needsYou).toHaveLength(1));
      expect(second.finished).toBe(0);
    });

    it('still answers the notice senders when a listener on the watcher throws', async () => {
      watcher.on('outcome', () => { throw new Error('listener broke'); });
      complete();
      const seen = route();
      await answer(verdictJson({ verdict: 'finished', stop: 'work_complete', basis: 'none' }));
      await vi.waitFor(() => expect(seen.finished).toBe(1));
    });

    it('works when the idle change arrives before the completion event', async () => {
      const seen = route();
      complete();
      await answer(verdictJson({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none' }));
      await settled();
      await tick();
      expect(seen.needsYou).toHaveLength(1);
      expect(seen.finished).toBe(0);
    });

    it('sends the usual notice when no finished turn ever arrives, even after a stalled main process', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] });
      const seen = route();
      await vi.advanceTimersByTimeAsync(2_900);
      expect(seen.finished).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(seen).toEqual({ finished: 1, needsYou: [] });
    });

    it('does not delay a session the watcher does not look after', () => {
      instance.parentId = 'parent';
      expect(route()).toEqual({ finished: 1, needsYou: [] });
      instance.parentId = null;
      level = 'off';
      expect(route()).toEqual({ finished: 1, needsYou: [] });
    });

    it('sends the usual notice straight away once the watcher has stopped', () => {
      watcher.stop();
      expect(route()).toEqual({ finished: 1, needsYou: [] });
    });
  });

  describe('what happened next', () => {
    const followUps = (): Record<string, unknown>[] => logRows().filter((row) => row['event'] === 'follow-up');
    async function flagThenReply(reply: string): Promise<void> {
      complete();
      await answer(verdictJson({ verdict: 'needs_user', stop: 'offered_choice', basis: 'none' }));
      await settled();
      events.emit('instance:input-started', { instanceId: 'root', autoContinuation: false });
      instance.requestCount += 1;
      instance.outputBuffer = [...instance.outputBuffer, typed(reply), message('assistant', 'Done.')];
      complete();
      await vi.waitFor(() => expect(followUps()).toHaveLength(1));
    }

    it('records a bare go-ahead after a flag, by class and length only', async () => {
      await flagThenReply('yes please');
      expect(followUps()[0]).toMatchObject({ kind: 'person-message', requestCount: 3, bareGoAhead: true, chars: 10 });
      expect(JSON.stringify(logRows())).not.toContain('yes please');
    });

    it('records a longer reply as not a go-ahead', async () => {
      await flagThenReply('No, use the other branch and tell me what changed first.');
      expect(followUps()[0]).toMatchObject({ kind: 'person-message', bareGoAhead: false });
    });

    it('counts outward commands in a turn it carried on', async () => {
      complete();
      await answer(verdictJson());
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      instance.outputBuffer = [
        ...instance.outputBuffer,
        message('system', sent[0], { internalInput: { actor: 'harness', source: 'session-watcher' } }),
        message('tool_use', '', { name: 'Bash', input: { command: 'npm test' } }),
        message('tool_use', '', { name: 'Bash', input: { command: 'git push origin main' } }),
        message('assistant', 'Phase 2 is done.'),
      ];
      complete();
      await vi.waitFor(() => expect(followUps()).toHaveLength(1));
      expect(followUps()[0]).toMatchObject({ kind: 'carried-turn', requestCount: 3, tools: 2, outwardCommands: 1 });
    });

    it('records Stop pressed during a turn it carried on', async () => {
      complete();
      await answer(verdictJson());
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      events.emit('instance:interrupt-requested', { instanceId: 'root' });
      expect(followUps()).toMatchObject([{ kind: 'stop-pressed', requestCount: 3 }]);
    });
  });

  it('runs at most two judge calls at once', async () => {
    const others = ['second', 'third'].map((id) => ({ ...instance, id, outputBuffer: conversation() } as Instance));
    const byId = new Map<string, Instance>([['root', instance], ...others.map((entry): [string, Instance] => [entry.id, entry])]);
    host.getInstance = (id: string) => byId.get(id);
    for (const id of byId.keys()) {
      events.emit('provider:normalized-event', {
        eventId: 'e', seq: 1, timestamp: Date.now(), instanceId: id, provider: 'claude',
        event: { kind: 'complete', requestCountAtCompletion: 3 },
      } as unknown as ProviderRuntimeEventEnvelope);
    }
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(judgeCalls).toHaveLength(2);
    judgeCalls[0].resolve(verdictJson({ verdict: 'finished', stop: 'work_complete', basis: 'none' }));
    await vi.waitFor(() => expect(judgeCalls).toHaveLength(3));
  });
});
