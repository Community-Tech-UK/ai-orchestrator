import type { ConnectionState } from './gateway-client.service';

/**
 * Presentation for the gateway connection state.
 *
 * Kept as pure functions, separate from the client, because the same state has to
 * read correctly in three places (host list, header subtitle, offline copy) and
 * they previously drifted: the header interpolated the raw enum, so an expired
 * pairing surfaced to the user as the literal text "unauthorized".
 */

/** The one action that actually fixes a rejected device token. */
const REPAIR_GUIDANCE = 'Pair this phone again from the desktop app under Settings, Mobile.';

const NOT_PAIRED = 'This phone is no longer paired with the host.';

/**
 * Shown wherever a request fails because the device token was rejected. The
 * gateway answers a 401 with the bare word "Unauthorized", which several screens
 * used to render verbatim; this is what the user sees instead.
 */
export function authFailureMessage(): string {
  return `${NOT_PAIRED} ${REPAIR_GUIDANCE}`;
}

/**
 * Lowercase label for status pills and ` · `-joined detail lines. Every state maps
 * to real words: returning the enum for unhandled cases is how "unauthorized"
 * leaked into the header in the first place.
 */
export function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'online';
    case 'connecting':
      return 'connecting';
    case 'unauthorized':
      return 'pairing expired';
    default:
      return 'offline';
  }
}

/**
 * Why a host can't be used right now, for the host-picker row. Names an expired
 * pairing rather than lumping it in with "unavailable".
 */
export function hostAvailabilityText(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected host';
    case 'connecting':
      return 'Connecting to host';
    case 'unauthorized':
      return 'Pairing expired — re-pair to use';
    default:
      return 'Host unavailable';
  }
}

/** Why the composer is disabled. */
export function composerBlockedText(state: ConnectionState): string {
  return state === 'unauthorized'
    ? authFailureMessage()
    : 'Reconnect to a host to start a session.';
}

/**
 * Placeholder for a conversation with no messages loaded. A relaunch resumes
 * straight into this screen (`resume-route.ts` treats `/projects...` as
 * restorable) with an empty transcript, so for a dead token this is the first —
 * and possibly only — text the user sees. It used to read "Connecting…" forever.
 */
export function emptyTranscriptText(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'No messages yet.';
    case 'connecting':
      return 'Connecting…';
    case 'unauthorized':
      return authFailureMessage();
    default:
      return 'Offline. Reconnect to load this conversation.';
  }
}

/** Capitalised standalone label for header subtitles and the composer status. */
export function connectionHeadline(state: ConnectionState): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'unauthorized':
      return 'Pairing expired';
    default:
      return 'Offline';
  }
}

/** Full-screen copy shown when there is nothing cached to fall back on. */
export function connectionHelpText(state: ConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting to the selected host.';
    case 'unauthorized':
      // The host is reachable and Tailscale is fine — only the pairing is dead,
      // so the generic network copy would send the user after the wrong problem.
      return authFailureMessage();
    default:
      return 'Reconnect to Tailscale or choose another host.';
  }
}

/**
 * Banner shown above cached sessions while offline. A long-lived phone almost
 * always has cached sessions when its token finally expires, so this — not the
 * empty state — is where the re-pair prompt usually has to land.
 */
export function offlineBannerText(state: ConnectionState): string {
  if (state === 'unauthorized') {
    return `${NOT_PAIRED} Cached sessions remain available. ${REPAIR_GUIDANCE}`;
  }
  return 'Offline. Cached sessions remain available; reconnect to start new work.';
}
