import { describe, expect, it } from 'vitest';
import {
  aggregateBrowserRendererState,
  classifyBrowserTargetLiveness,
} from './browser-target-liveness';

describe('browser target liveness', () => {
  const now = new Date('2026-01-15T12:03:00.000Z');

  it('recognizes only the Jaggaer Greenwich clock family', () => {
    expect(classifyBrowserTargetLiveness({
      text: 'Portal header 12:03 Greenwich Mean Time',
      now,
    })).toMatchObject({ renderer: 'healthy', clockText: '12:03 Greenwich Mean Time' });
    expect(classifyBrowserTargetLiveness({
      text: 'Portal header 13:03 Greenwich Mean Time DST',
      now,
    })).toMatchObject({ renderer: 'healthy', clockText: '13:03 Greenwich Mean Time DST' });
    expect(classifyBrowserTargetLiveness({
      text: 'Updated 15 January 2026 at 12:03 GMT',
      now,
    })).toEqual({ renderer: 'unknown' });
    expect(classifyBrowserTargetLiveness({
      text: '12:03 Greenwich Mean Time DSTextra',
      now,
    })).toEqual({ renderer: 'unknown' });
  });

  it('marks clocks stale only after the exact 180-second threshold', () => {
    expect(classifyBrowserTargetLiveness({
      text: '12:00 Greenwich Mean Time',
      now,
    }).renderer).toBe('healthy');
    expect(classifyBrowserTargetLiveness({
      text: '12:00 Greenwich Mean Time',
      now: new Date('2026-01-15T12:03:01.000Z'),
    })).toMatchObject({
      renderer: 'wedged',
      clockText: '12:00 Greenwich Mean Time',
      clockAgeSeconds: 181,
      suggestedAction: 'browser.reload',
    });
  });

  it('compares clock age circularly across midnight', () => {
    expect(classifyBrowserTargetLiveness({
      text: '23:59 Greenwich Mean Time',
      now: new Date('2026-01-16T00:01:00.000Z'),
    }).renderer).toBe('healthy');
    expect(classifyBrowserTargetLiveness({
      text: '23:59 Greenwich Mean Time',
      now: new Date('2026-01-16T00:02:00.000Z'),
    })).toMatchObject({ renderer: 'healthy', clockAgeSeconds: 180 });
    expect(classifyBrowserTargetLiveness({
      text: '23:59 Greenwich Mean Time',
      now: new Date('2026-01-16T00:02:01.000Z'),
    })).toMatchObject({ renderer: 'wedged', clockAgeSeconds: 181 });
  });

  it('lets the managed renderer wedge signal override a fresh clock', () => {
    expect(classifyBrowserTargetLiveness({
      text: '12:03 Greenwich Mean Time',
      now,
      managedRendererWedged: true,
    })).toMatchObject({ renderer: 'wedged', suggestedAction: 'browser.reload' });
  });

  it('aggregates without marking unrelated targets wedged', () => {
    const targets = [
      { profileId: 'p1', targetId: 't1', renderer: 'wedged' as const },
      { profileId: 'p2', targetId: 't2', renderer: 'healthy' as const },
    ];
    expect(aggregateBrowserRendererState(targets)).toBe('wedged');
    expect(targets[1].renderer).toBe('healthy');
  });
});
