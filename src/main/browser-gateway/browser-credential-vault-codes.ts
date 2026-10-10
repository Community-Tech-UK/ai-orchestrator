import type { CredentialVaultErrorCode } from './browser-credential-vault';

/**
 * Every code `CredentialVaultError` can carry, as data — kept in its own module
 * so browser-credential-vault.ts stays inside its size ceiling.
 *
 * The credential fill failure boundary (browser-credential-fill-targeting)
 * builds its allowlist from this list so a vault code can cross without
 * trusting an error's shape. The `satisfies Record<CredentialVaultErrorCode,
 * true>` is the exhaustiveness pin: adding a member to the union without
 * listing it here is a COMPILE error, not a silent gap in that boundary.
 */
export const CREDENTIAL_VAULT_ERROR_CODE_COVERAGE = {
  vault_locked: true,
  folder_unavailable: true,
  item_not_found: true,
  item_ambiguous: true,
  item_changed: true,
  target_unavailable: true,
  shared_tab_credential_fill_not_allowed: true,
  shared_tab_secure_credential_fill_unavailable: true,
  item_outside_agent_folder: true,
  origin_binding_missing: true,
  origin_mismatch: true,
  bw_command_failed: true,
  secret_field_empty: true,
  custom_field_not_found: true,
  'vault_relock_failed:empty_password': true,
  'vault_relock_failed:bw_unlock_failed': true,
  'vault_relock_failed:empty_session': true,
} satisfies Record<CredentialVaultErrorCode, true>;

export const CREDENTIAL_VAULT_ERROR_CODES: readonly CredentialVaultErrorCode[] =
  Object.keys(CREDENTIAL_VAULT_ERROR_CODE_COVERAGE) as CredentialVaultErrorCode[];

/** Codes minted AFTER a dispatch succeeded, by the write confirmation itself. */
export const WRITE_CONFIRMATION_CODES: ReadonlySet<string> = new Set([
  'shared_tab_secure_credential_write_not_confirmed',
  'shared_tab_public_credential_write_not_confirmed',
]);
