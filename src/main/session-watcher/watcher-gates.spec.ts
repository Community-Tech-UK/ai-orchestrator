import { describe, expect, it } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../shared/types/instance.types';
import {
  isErrorNotice, watcherCoversSession, watcherReplySkipReason, watcherStateSkipReason, watcherTurnSkipReason, type WatcherGateDeps,
} from './watcher-gates';

const instance = (overrides: Partial<Instance> = {}): Instance => ({
  id: 'root', parentId: null, childrenIds: [], launchMode: 'orchestrated', provider: 'claude', status: 'idle',
  requestCount: 4, metadata: {}, planMode: { enabled: false, state: 'off' }, outputBuffer: [], ...overrides,
} as unknown as Instance);
const deps = (overrides: Partial<WatcherGateDeps> = {}): WatcherGateDeps => ({
  level: () => 'own-suggestions', isLoopChat: () => false, isSideChat: () => false, isPaused: () => false,
  hasInhibitor: () => false, hasOpenRequest: () => false, hasPendingContinuation: () => false, ...overrides,
});
const completion = (event: Record<string, unknown> = {}): ProviderRuntimeEventEnvelope => ({
  instanceId: 'root', event: { kind: 'complete', requestCountAtCompletion: 4, ...event },
} as unknown as ProviderRuntimeEventEnvelope);
const none = (): undefined => undefined;

describe('watcherCoversSession', () => {
  it('covers the user\'s own Claude chat session', () => {
    expect(watcherCoversSession(instance(), deps())).toBe(true);
  });

  it.each([
    ['the setting is off', instance(), deps({ level: () => 'off' })],
    ['the session is muted', instance({ watcherMuted: true }), deps()],
    ['it is a helper agent', instance({ parentId: 'parent' }), deps()],
    ['it was not started by Harness', instance({ launchMode: 'interactive' }), deps()],
    ['it is a Plan Queue job', instance({ metadata: { planQueueRole: 'worker' } }), deps()],
    ['it is an automation', instance({ metadata: { automationId: 'a1' } }), deps()],
    ['it is a review', instance({ metadata: { pingPongReviewer: true } }), deps()],
    ['it is a channel reply', instance({ metadata: { spendPurpose: 'channel' } }), deps()],
    ['it belongs to a phone member', instance({ metadata: { mobileProfileId: 'member-1' } }), deps()],
    ['it is on another provider', instance({ provider: 'codex' }), deps()],
    ['it drives an active loop', instance(), deps({ isLoopChat: () => true })],
    ['it is a side chat', instance(), deps({ isSideChat: () => true })],
  ])('leaves a session alone when %s', (_name, target, gate) => {
    expect(watcherCoversSession(target, gate)).toBe(false);
  });
});

describe('watcherTurnSkipReason', () => {
  it('judges a normally finished turn', () => {
    expect(watcherTurnSkipReason(completion(), instance(), deps(), none)).toBeNull();
    expect(watcherTurnSkipReason(completion({ turnEnding: { reason: 'completed', evidence: 'x' } }), instance(), deps(), none)).toBeNull();
  });

  it.each([
    ['ended-max_output', completion({ turnEnding: { reason: 'max_output', evidence: 'x' } }), instance()],
    ['auto-continue-suppressed', completion({ turnEnding: { reason: 'completed', evidence: 'x', autoContinueSuppressed: true } }), instance()],
    ['degraded', completion({ degradedReason: 'something' }), instance()],
    ['quota', completion({ quota: { exhausted: true } }), instance()],
    ['quota', completion({ rateLimit: { remaining: 0 } }), instance()],
    ['stale-completion', completion({ requestCountAtCompletion: 3 }), instance()],
    ['stale-completion', completion({ requestCountAtCompletion: undefined }), instance()],
    ['turn-interrupted', completion(), instance({ lastTurnOutcome: 'interrupted' })],
    ['turn-failed', completion(), instance({ lastTurnOutcome: 'failed' })],
  ])('skips with %s', (reason, envelope, target) => {
    expect(watcherTurnSkipReason(envelope, target, deps(), none)).toBe(reason);
  });
});

describe('watcherStateSkipReason', () => {
  it.each([
    ['asleep', instance({ status: 'hibernated' }), deps()],
    ['asleep', instance({ status: 'hibernating' }), deps()],
    ['asleep', instance({ status: 'waking' }), deps()],
    ['status-waiting_for_permission', instance({ status: 'waiting_for_permission' }), deps()],
    ['status-error', instance({ status: 'error' }), deps()],
    ['waiting-quota-park', instance({ waitReason: { kind: 'quota-park', provider: 'claude', resumeAt: 1 } as Instance['waitReason'] }), deps()],
    ['plan-mode', instance({ planMode: { enabled: true, state: 'planning' } as Instance['planMode'] }), deps()],
    ['paused', instance(), deps({ isPaused: () => true })],
    ['background-work', instance(), deps({ hasInhibitor: () => true })],
    ['open-request', instance(), deps({ hasOpenRequest: () => true })],
    ['continuation-queued', instance(), deps({ hasPendingContinuation: () => true })],
  ])('skips with %s', (reason, target, gate) => {
    expect(watcherStateSkipReason(target, gate, none)).toBe(reason);
  });

  it('skips while a helper agent is still running, not once it has finished', () => {
    const parent = instance({ childrenIds: ['child'] });
    expect(watcherStateSkipReason(parent, deps(), () => instance({ id: 'child', status: 'busy' }))).toBe('helpers-running');
    expect(watcherStateSkipReason(parent, deps(), () => instance({ id: 'child', status: 'idle' }))).toBeNull();
    expect(watcherStateSkipReason(parent, deps(), none)).toBeNull();
  });

  it('allows a session that is ready or still settling', () => {
    for (const status of ['idle', 'ready', 'busy'] as const) expect(watcherStateSkipReason(instance({ status }), deps(), none)).toBeNull();
  });
});

describe('watcherReplySkipReason', () => {
  it('judges an ordinary closing question', () => {
    expect(watcherReplySkipReason('Phase 1 is done. Shall I carry on with phase 2?', 1)).toBeNull();
  });

  it.each([
    ['no-typed-message', 'Shall I carry on?', 0, undefined],
    ['no-reply', '   ', 1, undefined],
    ['error-notice', 'API Error: 529 overloaded', 1, undefined],
    ['error-notice', 'No response requested.', 1, undefined],
    ['error-notice', "You've hit your 5-hour limit · resets 10:20pm (Europe/London)", 1, undefined],
    ['error-notice', 'Failed to authenticate. Please sign in again.', 1, undefined],
    ['error-notice', 'Anything at all', 1, '<synthetic>'],
    ['waiting-on-work', "I'm waiting for the build to finish.", 1, undefined],
  ])('skips with %s', (reason, reply, typed, model) => {
    expect(watcherReplySkipReason(reply, typed, model)).toBe(reason);
  });
});

describe('isErrorNotice', () => {
  it('does not mistake a real reply that mentions an error for a notice', () => {
    expect(isErrorNotice('I fixed the API error handling in the client and added a retry. Shall I run the tests?')).toBe(false);
    expect(isErrorNotice(`${'A long report. '.repeat(60)}API Error: 500`)).toBe(false);
  });

  it('stays fast on long input', () => {
    const started = performance.now();
    isErrorNotice(`API Error ${'x '.repeat(200_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
