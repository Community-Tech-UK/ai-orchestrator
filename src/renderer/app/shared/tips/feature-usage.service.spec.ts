import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { FeatureUsageService } from './feature-usage.service';

describe('local working-tip usage', () => {
  beforeEach(() => { TestBed.resetTestingModule(); localStorage.removeItem('working-tips:v1'); });

  it('records usage and shown counts across a renderer storage round trip', () => {
    const usage = TestBed.inject(FeatureUsageService);
    expect(usage.count('steer')).toBe(0);
    usage.record('steer'); usage.record('steer'); usage.markShown('side-chat');
    expect(usage.count('steer')).toBe(2);
    TestBed.resetTestingModule();
    const reloaded = TestBed.inject(FeatureUsageService);
    expect(reloaded.count('steer')).toBe(2);
    expect(reloaded.shownCounts()['side-chat']).toBe(1);
    reloaded.retire('side-chat');
    expect(reloaded.shownCounts()['side-chat']).toBe(3);
  });

  it('ignores malformed and obsolete storage without throwing', () => {
    localStorage.setItem('working-tips:v1', JSON.stringify({ __v: 1, value: { usedCounts: { steer: -1 }, shownCounts: {} } }));
    expect(TestBed.inject(FeatureUsageService).count('steer')).toBe(0);
  });

  it('does not inherit counters from object prototype names', () => {
    const usage = TestBed.inject(FeatureUsageService);
    expect(usage.count('constructor')).toBe(0);
    usage.record('constructor');
    expect(usage.count('constructor')).toBe(1);
  });
});
