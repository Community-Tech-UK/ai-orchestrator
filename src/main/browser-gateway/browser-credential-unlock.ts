import type { BwRunner } from './browser-credential-vault';
import type { BrowserCredentialSession } from './browser-credential-session';

/**
 * Unlock the Bitwarden CLI and hand the resulting BW_SESSION to the in-memory
 * session holder, so the credential vault becomes usable for the run.
 *
 * The master password is passed to `bw` via the BW_PASSWORD env var of the
 * child process only (never argv, never logged), and the raw session token is
 * captured from stdout and kept solely in main-process memory. This function
 * never returns or logs either the password or the token.
 */

export interface UnlockCredentialVaultDeps {
  runner: BwRunner;
  session: Pick<BrowserCredentialSession, 'unlock'>;
  /** Resolve the vault master password (e.g. from a secure local file/keychain). */
  getMasterPassword: () => Promise<string>;
}

export interface UnlockResult {
  unlocked: boolean;
  reason?: 'empty_password' | 'bw_unlock_failed' | 'empty_session';
}

export async function unlockCredentialVault(
  deps: UnlockCredentialVaultDeps,
): Promise<UnlockResult> {
  const password = await deps.getMasterPassword();
  if (!password) {
    return { unlocked: false, reason: 'empty_password' };
  }

  const result = await deps.runner.run(['unlock', '--passwordenv', 'BW_PASSWORD', '--raw'], {
    env: { BW_PASSWORD: password },
  });
  if (result.code !== 0) {
    return { unlocked: false, reason: 'bw_unlock_failed' };
  }
  const token = result.stdout.trim();
  if (!token) {
    return { unlocked: false, reason: 'empty_session' };
  }

  deps.session.unlock(token);
  return { unlocked: true };
}
