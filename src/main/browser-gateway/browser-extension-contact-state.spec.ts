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

  it('replaces runtime evidence atomically and clears a missing version on reload', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });

    state.markExtensionRuntime('node-1', { extensionStartedAt: 2_000 });

    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
    state.markExtensionRuntime('node-1', {});
    expect(state.getExtensionRuntime('node-1')).toBeUndefined();
  });

  it('does not let a delayed older generation overwrite newer runtime evidence', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.2',
      extensionStartedAt: 2_000,
    });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });

    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.2',
      extensionStartedAt: 2_000,
    });
  });

  it('fails closed for inconsistent or incomplete evidence from the same generation', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionRuntime('node-1', { extensionStartedAt: 2_000 });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
  });

  it('tombstones a disconnected generation and ignores its delayed replay', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionDisconnect('node-1', 'native_port_closed');
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.18',
      extensionStartedAt: 3_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.18',
      extensionStartedAt: 3_000,
    });
  });

  it.each([-1, 1.5])('clears malformed generation evidence at %s', (extensionStartedAt) => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt,
    });

    expect(state.getExtensionRuntime('node-1')).toBeUndefined();
  });
});
