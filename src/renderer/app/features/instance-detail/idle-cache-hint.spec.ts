import { describe, expect, it } from 'vitest';
import { hasPendingSelfWakeup, idleHintFor, type IdleHintFacts } from './idle-cache-hint';

const MIN = 60_000;
const NOW = 10_000_000_000;

interface Message { metadata?: Record<string, unknown> }
const requested = (toolUseId: string, dueAt: number): Message => ({ metadata: { selfWakeup: { kind: 'requested', toolUseId, requestedAt: dueAt - 300_000, delaySeconds: 300, dueAt, reason: '' } } });
const refused = (toolUseId: string): Message => ({ metadata: { selfWakeup: { kind: 'refused', toolUseId, requestedAt: NOW } } });
const stopped = (toolUseId: string): Message => ({ metadata: { selfWakeup: { kind: 'stopped', toolUseId, requestedAt: NOW } } });

describe('hasPendingSelfWakeup', () => {
  it('sees a wake-up Claude asked for that has not come due', () => {
    expect(hasPendingSelfWakeup([{}, requested('t1', NOW + 20 * MIN)], NOW)).toBe(true);
  });

  it('keeps a due wake-up pending for the same grace as the main process, then lets go', () => {
    const due = NOW - 5 * MIN;
    expect(hasPendingSelfWakeup([requested('t1', due)], NOW)).toBe(true);
    expect(hasPendingSelfWakeup([requested('t1', NOW - 11 * MIN)], NOW)).toBe(false);
  });

  it('ignores a refused request, and everything before a cancellation', () => {
    expect(hasPendingSelfWakeup([requested('t1', NOW + 20 * MIN), refused('t1')], NOW)).toBe(false);
    expect(hasPendingSelfWakeup([requested('t1', NOW + 20 * MIN), stopped('t2')], NOW)).toBe(false);
    expect(hasPendingSelfWakeup([requested('t1', NOW + 20 * MIN), stopped('t2'), requested('t3', NOW + 30 * MIN)], NOW)).toBe(true);
  });

  it('copes with no messages, odd metadata and a long transcript', () => {
    expect(hasPendingSelfWakeup(undefined, NOW)).toBe(false);
    expect(hasPendingSelfWakeup([{ metadata: { selfWakeup: 'nonsense' } }, { metadata: { selfWakeup: { kind: 'requested' } } }], NOW)).toBe(false);
    const old = [requested('t1', NOW + 20 * MIN), ...Array.from({ length: 250 }, () => ({}))];
    expect(hasPendingSelfWakeup(old, NOW)).toBe(false); // beyond the scan window
  });
});

describe('idleHintFor', () => {
  const facts = (patch: Partial<IdleHintFacts['instance']> = {}, rest: Partial<IdleHintFacts> = {}): IdleHintFacts => ({
    instance: {
      provider: 'claude', status: 'idle', lastActivity: NOW - 80 * MIN,
      contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true },
      outputBuffer: [],
      ...patch,
    },
    hasScheduledWakeUp: false,
    hasActiveLoop: false,
    now: NOW,
    ...rest,
  });

  it('suggests a fresh session after 80 idle minutes at 230K', () => {
    expect(idleHintFor(facts())).toEqual({
      show: true, tokens: 230_000,
      text: 'Starting something new? A fresh session would skip re-reading about 230K tokens.',
    });
  });

  it.each([
    ['a scheduled wake-up is aimed at it', {}, { hasScheduledWakeUp: true }],
    ['a loop is attached to it', {}, { hasActiveLoop: true }],
    ['it is waiting on something', { waitReason: { kind: 'quota-park', provider: 'claude', resumeAt: NOW + MIN } }, {}],
    ['background agents are running', { backgroundWork: { count: 2, since: NOW - MIN } }, {}],
    ['a permission or question dialog is open', { pendingApprovalCount: 1 }, {}],
    ['Claude asked to be woken', { outputBuffer: [requested('t1', NOW + 20 * MIN)] }, {}],
  ])('stays quiet when %s', (_name, instancePatch, rest) => {
    expect(idleHintFor(facts(instancePatch as Partial<IdleHintFacts['instance']>, rest as Partial<IdleHintFacts>))).toMatchObject({ show: false });
  });

  it('stays quiet for spend totals, other providers and short idle times', () => {
    expect(idleHintFor(facts({ contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true, occupancyIsAggregate: true } }))).toMatchObject({ show: false });
    expect(idleHintFor(facts({ provider: 'codex' }))).toMatchObject({ show: false });
    expect(idleHintFor(facts({ lastActivity: NOW - 74 * MIN }))).toMatchObject({ show: false });
  });
});
