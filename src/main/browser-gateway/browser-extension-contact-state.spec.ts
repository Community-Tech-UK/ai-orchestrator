import { describe, expect, it } from 'vitest';
import {
  BROWSER_EXTENSION_CONTACT_GAP_THRESHOLD_MS,
  BrowserExtensionContactState,
} from './browser-extension-contact-state';

describe('BrowserExtensionContactState gap telemetry', () => {
  it('starts with empty gap stats', () => {
    const state = new BrowserExtensionContactState({ now: () => 0 });
    expect(state.getContactGapStats('node-1')).toEqual({ gapCount: 0, longestGapMs: 0 });
  });

  it('ignores healthy poll cadence and counts only outage-sized gaps', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionContact('node-1', 1_000);
    // Healthy long-poll cadence: well under the outage threshold.
    state.markExtensionContact('node-1', 11_000);
    expect(state.getContactGapStats('node-1')).toEqual({ gapCount: 0, longestGapMs: 0 });

    // Service-worker nap: contact resumes after an outage-sized silence.
    const gapMs = BROWSER_EXTENSION_CONTACT_GAP_THRESHOLD_MS + 35_000;
    state.markExtensionContact('node-1', 11_000 + gapMs);
    expect(state.getContactGapStats('node-1')).toEqual({
      gapCount: 1,
      longestGapMs: gapMs,
      lastGapMs: gapMs,
      lastGapEndedAt: 11_000 + gapMs,
    });
  });

  it('tracks the longest gap across multiple outages per node', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionContact('node-1', 0);
    state.markExtensionContact('node-1', 100_000);
    state.markExtensionContact('node-1', 140_000);
    expect(state.getContactGapStats('node-1')).toMatchObject({
      gapCount: 2,
      longestGapMs: 100_000,
      lastGapMs: 40_000,
    });
    // Other nodes are unaffected.
    expect(state.getContactGapStats('node-2')).toEqual({ gapCount: 0, longestGapMs: 0 });
  });

  it('forgets gap stats when a node is expired', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionContact('node-1', 0);
    state.markExtensionContact('node-1', 100_000);
    state.forgetNode('node-1');
    expect(state.getContactGapStats('node-1')).toEqual({ gapCount: 0, longestGapMs: 0 });
  });
});
