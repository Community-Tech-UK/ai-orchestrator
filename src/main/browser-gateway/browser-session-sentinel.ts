/**
 * Session resilience for unattended runs: detect when an agent-owned profile
 * has been logged out mid-campaign, so the caller can auto re-login (from the
 * credential vault) and resume the in-flight form rather than silently filling
 * a login page.
 *
 * Pure decision logic — the actual snapshotting + re-login orchestration lives
 * in the service. A login fingerprint captured right after a successful login
 * is compared against the current page signal.
 */

export interface SessionFingerprint {
  /** Selectors/text that are present ONLY when logged in (e.g. a logout link). */
  loggedInMarkers: string[];
  /** The canonical login URL to navigate to for re-authentication. */
  loginUrl: string;
}

export interface PageSessionSignal {
  url: string;
  /** A password field is visible on the page. */
  hasPasswordField: boolean;
  /** Visible text / accessible names currently on the page (lowercased ok). */
  presentTexts: string[];
}

export type SessionState = 'logged_in' | 'logged_out' | 'unknown';

export interface SessionEvaluation {
  state: SessionState;
  reason: string;
}

const LOGGED_OUT_URL_PATTERN = /\b(log[\s-]?in|sign[\s-]?in|sso|oauth|auth\/|account\/login)\b/i;

/**
 * Decide whether the current page indicates a logged-out session.
 *
 * Precedence:
 *  1. A visible password field OR a login-shaped URL ⇒ logged_out (strong).
 *  2. All fingerprint logged-in markers present ⇒ logged_in.
 *  3. Otherwise unknown (caller should probe rather than assume).
 */
export function evaluateSessionState(
  signal: PageSessionSignal,
  fingerprint?: SessionFingerprint,
): SessionEvaluation {
  if (signal.hasPasswordField) {
    return { state: 'logged_out', reason: 'password_field_present' };
  }
  if (LOGGED_OUT_URL_PATTERN.test(signal.url)) {
    return { state: 'logged_out', reason: 'login_url' };
  }

  if (fingerprint && fingerprint.loggedInMarkers.length > 0) {
    const haystack = signal.presentTexts.map((text) => text.toLowerCase());
    const allPresent = fingerprint.loggedInMarkers.every((marker) =>
      haystack.some((text) => text.includes(marker.toLowerCase())),
    );
    if (allPresent) {
      return { state: 'logged_in', reason: 'fingerprint_matched' };
    }
    return { state: 'logged_out', reason: 'fingerprint_markers_missing' };
  }

  return { state: 'unknown', reason: 'no_fingerprint' };
}

export interface ReloginPlan {
  loginUrl: string;
  /** Max re-login attempts before escalating to a human. */
  maxAttempts: number;
}

export class SessionSentinel {
  private readonly fingerprints = new Map<string, SessionFingerprint>();

  private key(profileId: string, origin: string): string {
    return `${profileId}::${origin}`;
  }

  /** Record the logged-in fingerprint captured right after a successful login. */
  remember(profileId: string, origin: string, fingerprint: SessionFingerprint): void {
    this.fingerprints.set(this.key(profileId, origin), fingerprint);
  }

  getFingerprint(profileId: string, origin: string): SessionFingerprint | undefined {
    return this.fingerprints.get(this.key(profileId, origin));
  }

  evaluate(profileId: string, origin: string, signal: PageSessionSignal): SessionEvaluation {
    return evaluateSessionState(signal, this.getFingerprint(profileId, origin));
  }

  /**
   * Produce a re-login plan when logged out and a fingerprint (hence a login
   * URL) is known. Returns null when we cannot safely auto-recover (no
   * fingerprint) — the caller must escalate to a human instead.
   */
  planRelogin(
    profileId: string,
    origin: string,
    signal: PageSessionSignal,
    maxAttempts = 2,
  ): ReloginPlan | null {
    const evaluation = this.evaluate(profileId, origin, signal);
    if (evaluation.state !== 'logged_out') {
      return null;
    }
    const fingerprint = this.getFingerprint(profileId, origin);
    if (!fingerprint) {
      return null;
    }
    return { loginUrl: fingerprint.loginUrl, maxAttempts };
  }
}
