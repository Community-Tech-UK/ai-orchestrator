/**
 * In-memory holder for the Bitwarden CLI session token (BW_SESSION).
 *
 * The token is set once when James unlocks the vault (via an interactive flow)
 * and lives only in main-process memory — never written to disk, never logged,
 * never sent to the renderer or the model. When no token is set the credential
 * vault is "locked" and browser.fill_credential is unavailable, which is the
 * safe default on every fresh launch.
 */
export class BrowserCredentialSession {
  private token: string | undefined;

  getToken(): string | undefined {
    return this.token;
  }

  get locked(): boolean {
    return this.token === undefined;
  }

  /** Set the BW_SESSION after a successful `bw unlock`. */
  unlock(session: string): void {
    this.token = session.length > 0 ? session : undefined;
  }

  /** Drop the token (e.g. on app shutdown or manual re-lock). */
  lock(): void {
    this.token = undefined;
  }
}

let singleton: BrowserCredentialSession | null = null;

export function getBrowserCredentialSession(): BrowserCredentialSession {
  if (!singleton) {
    singleton = new BrowserCredentialSession();
  }
  return singleton;
}

export function _resetBrowserCredentialSessionForTesting(): void {
  singleton = null;
}
