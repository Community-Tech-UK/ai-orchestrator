import { describe, expect, it } from 'vitest';
import { pickTip, type TipContext } from './tip-policy';
import type { WorkingTip } from './tip-catalogue';

const catalogue: WorkingTip[] = [
  { id: 'first', featureId: 'first-feature', text: 'First tip' },
  { id: 'second', featureId: 'second-feature', text: 'Second tip', shortcutActionId: 'shortcut' },
];
const ready = (patch: Partial<TipContext> = {}): TipContext => ({
  now: 1_000_000, busySince: 970_000, enabled: true, composerText: '', queuedCount: 0,
  lastKeystrokeAt: null, modalOpen: false, activeLoop: false, shownThisLaunch: 0,
  lastShownAt: null, previousTipId: null, shownThisBusyPeriod: false, usedCounts: {},
  shownCounts: {}, shortcuts: { shortcut: 'Ctrl+K' }, sessionCount: 4, hasReply: true,
  contextPercentage: 70, compactPreviewAvailable: false,
  ...patch,
});

describe('working tip policy', () => {
  it('waits thirty seconds and offers the first unused tip at the boundary', () => {
    expect(pickTip(ready({ busySince: 970_001 }), catalogue)).toBeNull();
    expect(pickTip(ready(), catalogue)?.id).toBe('first');
  });

  it.each([
    ['composer text', { composerText: 'draft' }], ['queued message', { queuedCount: 1 }],
    ['recent keystroke', { lastKeystrokeAt: 998_000 }], ['modal', { modalOpen: true }],
    ['third launch tip', { shownThisLaunch: 2 }], ['cooldown', { lastShownAt: 401_000 }],
    ['active loop', { activeLoop: true }], ['tips off', { enabled: false }],
    ['already shown this turn', { shownThisBusyPeriod: true }], ['idle', { busySince: null }],
  ] satisfies [string, Partial<TipContext>][])('suppresses for %s', (_reason, patch) => {
    expect(pickTip(ready(patch), catalogue)).toBeNull();
  });

  it('drops a previous, used, or lifetime-capped tip', () => {
    expect(pickTip(ready({ previousTipId: 'first' }), catalogue)?.id).toBe('second');
    expect(pickTip(ready({ usedCounts: { 'first-feature': 1 } }), catalogue)?.id).toBe('second');
    expect(pickTip(ready({ shownCounts: { first: 3 } }), catalogue)?.id).toBe('second');
    expect(pickTip(ready({ usedCounts: { 'first-feature': 1 }, shortcuts: {} }), catalogue)).toBeNull();
  });

  it('chooses the least shown tip before catalogue order and respects relevance', () => {
    expect(pickTip(ready({ shownCounts: { first: 1 } }), catalogue)?.id).toBe('second');
    expect(pickTip(ready(), [{ ...catalogue[0], relevantWhen: () => false }])).toBeNull();
  });
});
