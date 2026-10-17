import { describe, expect, it } from 'vitest';
import {
  BROWSER_EXTENSION_CONTACT_GAP_THRESHOLD_MS,
  BrowserExtensionContactState,
  normalizeBrowserExtensionInstanceId,
} from './browser-extension-contact-state';
import { supportsSecureBrowserExtensionCredentialFill } from './browser-extension-credential-compatibility';

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

  it('replaces runtime evidence atomically and ignores incomplete polls on a proven generation', () => {
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
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
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

  it('keeps a proven generation when a sibling poll omits version', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionRuntime('node-1', { extensionStartedAt: 2_000 });
    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });
  });

  it('fails closed for contradictory versions on the same generation', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.18',
      extensionStartedAt: 2_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });
  });

  it('restores a disconnected generation from a later complete sibling poll', () => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionDisconnect('node-1', 'native_port_closed');
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', { extensionStartedAt: 2_000 });
    expect(state.getExtensionRuntime('node-1')).toEqual({ extensionStartedAt: 2_000 });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.17',
      extensionStartedAt: 2_000,
    });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.18',
      extensionStartedAt: 3_000,
    });
    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.18',
      extensionStartedAt: 3_000,
    });
  });

  it.each([-1, 1.5])('ignores malformed generation evidence at %s', (extensionStartedAt) => {
    const state = new BrowserExtensionContactState();
    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });

    state.markExtensionRuntime('node-1', {
      extensionVersion: '0.2.17',
      extensionStartedAt,
    });

    expect(state.getExtensionRuntime('node-1')).toEqual({
      extensionVersion: '0.2.17',
      extensionStartedAt: 1_000,
    });
  });
});

describe('BrowserExtensionContactState with several Chrome profiles on one node', () => {
  const PROFILE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const PROFILE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
  const a = { extensionVersion: '0.2.42', extensionStartedAt: 100, extensionInstanceId: PROFILE_A };
  const b = { extensionVersion: '0.2.42', extensionStartedAt: 200, extensionInstanceId: PROFILE_B };

  function poll(state: BrowserExtensionContactState, runtime: typeof a): void {
    state.markExtensionContact('windows-pc');
    state.markExtensionRuntime('windows-pc', runtime);
  }

  it('keeps the earlier-started profile trusted after the later one polls', () => {
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, b);
    poll(state, a);

    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_A)).toBe(true);
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_B)).toBe(true);
  });

  it('only blocks the profile whose native host disconnected', () => {
    // Regression: before instance ids, profile B disconnecting tombstoned the
    // node's single generation and profile A was refused until B came back.
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, b);

    state.markExtensionDisconnect('windows-pc', 'native_host_stdin_eof', undefined, PROFILE_B);
    poll(state, a);

    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_A)).toBe(true);
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_B)).toBe(false);

    // B's own reconnect restores it.
    poll(state, b);
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_B)).toBe(true);
  });

  it('blocks every profile when the disconnect names none (node link dropped)', () => {
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, b);

    state.markExtensionDisconnect('windows-pc', 'node_ws_disconnected');

    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_A)).toBe(false);
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_B)).toBe(false);
  });

  it('judges an old extension in one profile without affecting the other', () => {
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, { ...b, extensionVersion: '0.2.17' });

    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_A)).toBe(true);
    expect(supportsSecureBrowserExtensionCredentialFill(state, 'windows-pc', PROFILE_B)).toBe(false);
  });

  it('answers an instance-less read with the profile that polled last', () => {
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, b);
    expect(state.getExtensionRuntime('windows-pc')).toEqual(b);
    poll(state, a);
    expect(state.getExtensionRuntime('windows-pc')).toEqual(a);
    expect(state.getExtensionRuntime('windows-pc', PROFILE_B)).toEqual(b);
  });

  it('forgets every profile with the node', () => {
    const state = new BrowserExtensionContactState();
    poll(state, a);
    poll(state, b);

    state.forgetNode('windows-pc');

    expect(state.getExtensionRuntime('windows-pc')).toBeUndefined();
    expect(state.getExtensionRuntime('windows-pc', PROFILE_A)).toBeUndefined();
    expect(state.getExtensionRuntime('windows-pc', PROFILE_B)).toBeUndefined();
  });

  it('treats a malformed profile id as no profile id', () => {
    const state = new BrowserExtensionContactState();
    poll(state, { ...a, extensionInstanceId: 'bad:id' });

    expect(state.getExtensionRuntime('windows-pc')).toEqual({
      extensionVersion: '0.2.42',
      extensionStartedAt: 100,
    });
    expect(normalizeBrowserExtensionInstanceId('bad:id')).toBeUndefined();
    expect(normalizeBrowserExtensionInstanceId(PROFILE_A)).toBe(PROFILE_A);
  });
});
