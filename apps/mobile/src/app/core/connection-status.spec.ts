import { describe, expect, it } from 'vitest';
import type { ConnectionState } from './gateway-client.service';
import {
  composerBlockedText,
  emptyTranscriptText,
  connectionHeadline,
  connectionLabel,
  connectionHelpText,
  hostAvailabilityText,
  offlineBannerText,
} from './connection-status';

const ALL_STATES: ConnectionState[] = ['disconnected', 'connecting', 'connected', 'unauthorized'];

describe('connection status presentation', () => {
  it('never leaks a raw state enum as a user-facing label', () => {
    expect(connectionLabel('connected')).toBe('online');
    expect(connectionLabel('unauthorized')).toBe('pairing expired');
    expect(connectionLabel('unauthorized')).not.toContain('unauthorized');
  });

  it('tells the user to re-pair — not to check Tailscale — when the token was rejected', () => {
    const help = connectionHelpText('unauthorized');
    expect(help).toContain('no longer paired');
    expect(help).toContain('Settings, Mobile');
    expect(help).not.toContain('Tailscale');
  });

  it('still blames the network when the host is genuinely unreachable', () => {
    expect(connectionHelpText('disconnected')).toContain('Tailscale');
    expect(connectionHelpText('connecting')).toContain('Connecting');
  });

  /**
   * The regression: a phone in daily use has cached sessions when its 90-day
   * token expires, so it renders the offline banner rather than the empty state.
   * That path used to show generic "reconnect" copy, leaving the user to guess.
   */
  it('carries the re-pair prompt into the banner shown over cached sessions', () => {
    const banner = offlineBannerText('unauthorized');
    expect(banner).toContain('no longer paired');
    expect(banner).toContain('Settings, Mobile');
    expect(banner).toContain('Cached sessions remain available');
    expect(banner).not.toContain('Tailscale');
  });

  it('keeps the plain offline banner for an ordinary disconnect', () => {
    expect(offlineBannerText('disconnected')).toBe(
      'Offline. Cached sessions remain available; reconnect to start new work.',
    );
  });

  /**
   * Guards the whole class of bug rather than one instance of it: the original
   * defect was a surface interpolating the state enum straight into the UI.
   * ('connecting' and 'connected' are excluded — those enum values happen to be
   * plain English already; 'unauthorized' and 'disconnected' are the jargon.)
   */
  it('never renders a jargon state value on any surface, for any state', () => {
    const jargon = ['unauthorized', 'disconnected'];
    for (const state of ALL_STATES) {
      for (const text of [connectionLabel(state), connectionHeadline(state)]) {
        expect(text).toBeTruthy();
        for (const word of jargon) {
          expect(text.toLowerCase()).not.toContain(word);
        }
      }
    }
  });

  it('names the expired pairing on the new-session host picker and composer', () => {
    expect(hostAvailabilityText('unauthorized')).toContain('Pairing expired');
    expect(hostAvailabilityText('connected')).toBe('Connected host');
    expect(hostAvailabilityText('disconnected')).toBe('Host unavailable');

    const blocked = composerBlockedText('unauthorized');
    expect(blocked).toContain('no longer paired');
    expect(blocked).toContain('Settings, Mobile');
    expect(composerBlockedText('disconnected')).toBe('Reconnect to a host to start a session.');
  });

  /**
   * A relaunch resumes straight into a conversation with an empty transcript, so
   * for a dead token this placeholder is the first text the user sees. It used to
   * say "Connecting…" forever.
   */
  it('does not claim to be connecting when the transcript is empty because the token died', () => {
    expect(emptyTranscriptText('unauthorized')).toContain('no longer paired');
    expect(emptyTranscriptText('unauthorized')).not.toContain('Connecting');
    expect(emptyTranscriptText('connecting')).toBe('Connecting…');
    expect(emptyTranscriptText('connected')).toBe('No messages yet.');
    expect(emptyTranscriptText('disconnected')).toContain('Offline');
  });

  it('gives headline surfaces a capitalised label that names an expired pairing', () => {
    expect(connectionHeadline('connected')).toBe('Connected');
    expect(connectionHeadline('connecting')).toBe('Connecting');
    expect(connectionHeadline('disconnected')).toBe('Offline');
    expect(connectionHeadline('unauthorized')).toBe('Pairing expired');
  });
});
