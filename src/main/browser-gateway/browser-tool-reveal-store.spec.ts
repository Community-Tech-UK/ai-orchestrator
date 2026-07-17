import { beforeEach, describe, expect, it } from 'vitest';
import {
  BrowserToolRevealStore,
  computeBrowserToolSurfaceParity,
  getBrowserToolRevealStore,
} from './browser-tool-reveal-store';

describe('BrowserToolRevealStore', () => {
  beforeEach(() => {
    BrowserToolRevealStore._resetForTesting();
  });

  it('accumulates revealed names per instance without duplicates', () => {
    const store = getBrowserToolRevealStore();
    store.recordRevealed('instance-1', ['browser.evaluate']);
    store.recordRevealed('instance-1', ['browser.evaluate', 'browser.wait_for']);
    store.recordRevealed('instance-2', ['browser.fill_form']);

    expect(store.getRevealed('instance-1')).toEqual([
      'browser.evaluate',
      'browser.wait_for',
    ]);
    expect(store.getRevealed('instance-2')).toEqual(['browser.fill_form']);
    expect(store.getRevealed('instance-3')).toEqual([]);
  });

  it('stores and lists reported surfaces', () => {
    const store = getBrowserToolRevealStore();
    const surface = {
      names: ['browser.click'],
      revealedNames: [],
      protocolVersion: 1,
      surfaceHash: 'abc',
      reportedAt: 123,
    };
    store.recordSurface('instance-1', surface);

    expect(store.getSurface('instance-1')).toEqual(surface);
    expect(store.getSurface('missing')).toBeNull();
    expect(store.listSurfaces()).toEqual([{ instanceId: 'instance-1', surface }]);
  });
});

describe('computeBrowserToolSurfaceParity', () => {
  it('reports missing, extra, and match flags', () => {
    const parity = computeBrowserToolSurfaceParity({
      reported: {
        names: ['browser.click', 'browser.legacy'],
        revealedNames: [],
        protocolVersion: 2,
        surfaceHash: 'reported-hash',
        reportedAt: 1,
      },
      expectedNames: ['browser.click', 'browser.evaluate'],
      expectedSurfaceHash: 'expected-hash',
      expectedProtocolVersion: 1,
    });

    expect(parity).toEqual({
      reportedCount: 2,
      expectedCount: 2,
      missing: ['browser.evaluate'],
      extra: ['browser.legacy'],
      surfaceHashMatch: false,
      protocolVersionMatch: false,
    });
  });
});
