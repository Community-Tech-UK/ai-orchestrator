import { MimoConsoleCredentialsReader, type MimoConsoleSession, type MimoCredentialResult } from './mimo-console-credentials-reader';
import type { MimoRenewedSsoCookie } from './mimo-console-session-renewer';
import { getMimoSavedSessionStore, type MimoSavedSessionStore } from './mimo-saved-session-store';
import type { MimoCredentialSource } from './mimo-token-plan-probe';

export interface MimoUsageCredentialsReaderOptions {
  accountProfileId: string;
  chromeProfile?: string;
  allowDefaultChrome?: boolean;
  savedStore?: MimoSavedSessionStore;
  chromeReader?: MimoCredentialSource;
}

/** One connection generation; old requests cannot survive a reconnect or disconnect. */
export class MimoUsageCredentialsReader implements MimoCredentialSource {
  readonly quotaSource: string;
  readonly retryDeniedRead: boolean;
  private readonly store: MimoSavedSessionStore;
  private readonly generation: number;
  private readonly saved: boolean;
  private readonly chrome?: MimoCredentialSource;

  constructor(private readonly opts: MimoUsageCredentialsReaderOptions) {
    this.store = opts.savedStore ?? getMimoSavedSessionStore();
    this.generation = this.store.generation(opts.accountProfileId);
    this.saved = this.store.exists(opts.accountProfileId);
    this.retryDeniedRead = this.saved;
    const chromeProfile = opts.chromeProfile ?? (opts.allowDefaultChrome ? 'Default' : undefined);
    this.quotaSource = this.saved ? `saved:${this.generation}` : `chrome:${chromeProfile ?? ''}`;
    // A saved login is authoritative, even when corrupt or expired. Reading
    // a Chrome fallback could otherwise show a different account's allowance.
    if (!this.saved && chromeProfile) {
      this.chrome = opts.chromeReader ?? new MimoConsoleCredentialsReader({ chromeProfile });
    }
  }

  async read(): Promise<MimoCredentialResult> {
    if (!this.isCurrent()) return { session: null, reason: 'not-found' };
    if (this.saved) return this.store.read(this.opts.accountProfileId);
    if (!this.chrome) return { session: null, reason: 'not-found' };
    try {
      const result = await this.chrome.read();
      return this.isCurrent() ? result : { session: null, reason: 'not-found' };
    } catch {
      return { session: null, reason: 'malformed' };
    }
  }

  async readAccountSso(): Promise<{ cookieHeader: string }> {
    if (!this.isCurrent()) return { cookieHeader: '' };
    if (this.saved) return this.store.readAccountSso(this.opts.accountProfileId);
    try {
      const result = await this.chrome?.readAccountSso?.();
      return this.isCurrent() ? result ?? { cookieHeader: '' } : { cookieHeader: '' };
    } catch { return { cookieHeader: '' }; }
  }

  isCurrent(): boolean {
    return this.store.generation(this.opts.accountProfileId) === this.generation
      && this.store.exists(this.opts.accountProfileId) === this.saved;
  }

  saveRenewed(session: MimoConsoleSession, sso?: readonly MimoRenewedSsoCookie[]): void {
    if (this.saved && this.isCurrent()) {
      this.store.saveRenewed(this.opts.accountProfileId, session, this.generation, sso);
    }
  }

  reauthError(reason?: string): string {
    if (reason === 'denied') return 'MiMo saved usage login could not be unlocked. Try Refresh again shortly.';
    if (reason === 'unsupported') return 'MiMo saved usage login cannot be read on this system.';
    return reason === 'rejected'
      ? 'MiMo usage login expired (401/403). Choose Connect usage in Accounts to sign in again.'
      : 'MiMo usage login is unavailable. Choose Connect usage in Accounts to sign in.';
  }
}
