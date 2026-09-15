/**
 * IPC channels for Claude/Codex account pools (provider account profiles).
 *
 * Everything crossing these channels is bounded, non-secret metadata: profile
 * IDs, labels, verified identities, plan labels, policy values and binding
 * STATES. No filesystem path, credential body or token travels either way —
 * a profile home is derived in main from a validated profile ID.
 *
 * Spec: docs/superpowers/specs/2026-09-13-provider-account-pools_spec_planned.md §11.
 */
export const PROVIDER_ACCOUNT_CHANNELS = {
  /** Renderer → main: profiles (optionally one provider) with binding state and pool policy. */
  PROVIDER_ACCOUNT_LIST: 'provider-account:list',
  /** Renderer → main: create a profile (metadata only; sign-in is separate). */
  PROVIDER_ACCOUNT_CREATE: 'provider-account:create',
  /** Renderer → main: rename, enable/disable, change policy, adopt observed identity. */
  PROVIDER_ACCOUNT_UPDATE: 'provider-account:update',
  /** Renderer → main: reorder a provider's pool. */
  PROVIDER_ACCOUNT_SET_PRIORITY_ORDER: 'provider-account:set-priority-order',
  /** Renderer → main: remove a profile. Rejected while a live session uses it. */
  PROVIDER_ACCOUNT_REMOVE: 'provider-account:remove',
  /** Renderer → main: re-check one profile's sign-in now (Codex also re-reads identity). */
  PROVIDER_ACCOUNT_VERIFY: 'provider-account:verify',
  /** Renderer → main: open a terminal signing in to one profile's home. */
  PROVIDER_ACCOUNT_LAUNCH_LOGIN: 'provider-account:launch-login',
  /** Renderer → main: read both providers' pool policy. */
  PROVIDER_ACCOUNT_POOL_READ: 'provider-account:pool-read',
  /** Renderer → main: change a provider's pool policy. */
  PROVIDER_ACCOUNT_POOL_UPDATE: 'provider-account:pool-update',
  /** Renderer → main: the one-time ownership acknowledgement (spec §5). */
  PROVIDER_ACCOUNT_ACKNOWLEDGE_OWNERSHIP: 'provider-account:acknowledge-ownership',
  /** Renderer → main: the Doctor report for a provider's pool. */
  PROVIDER_ACCOUNT_DOCTOR: 'provider-account:doctor',
  /** Renderer → main: the account a new session would get, and why. */
  PROVIDER_ACCOUNT_RESOLVE_PREVIEW: 'provider-account:resolve-preview',
  /** Renderer → main: move a live session to another account (explicit handoff). */
  PROVIDER_ACCOUNT_SWITCH_SESSION: 'provider-account:switch-session',
} as const;
