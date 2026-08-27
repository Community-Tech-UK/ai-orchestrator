/**
 * IPC channels for GitHub Copilot account profiles and routing rules.
 *
 * Everything crossing these channels is bounded, non-secret metadata: profile
 * IDs, labels, verified logins, normalized hosts, policy names, and typed
 * routing outcomes. No filesystem path, no config body, and no token material
 * travels either direction — the profile home is derived in main from a
 * validated profile ID and never leaves it.
 *
 * Spec: docs/superpowers/specs/2026-08-25-copilot-account-routing_spec.md §15.1.
 */
export const COPILOT_ACCOUNT_CHANNELS = {
  /** Renderer → main: profiles plus their node-local binding state. */
  COPILOT_ACCOUNT_LIST: 'copilot-account:list',
  /** Renderer → main: create a profile (metadata only; sign-in is separate). */
  COPILOT_ACCOUNT_CREATE: 'copilot-account:create',
  /** Renderer → main: rename a profile. Login/host stay verified metadata. */
  COPILOT_ACCOUNT_RENAME: 'copilot-account:rename',
  /** Renderer → main: change a profile's scope or automation policy. */
  COPILOT_ACCOUNT_UPDATE_POLICY: 'copilot-account:update-policy',
  /** Renderer → main: remove a profile. Rejected while a live session uses it. */
  COPILOT_ACCOUNT_REMOVE: 'copilot-account:remove',
  /** Renderer → main: make a profile the default for unmatched workspaces. */
  COPILOT_ACCOUNT_SET_DEFAULT: 'copilot-account:set-default',
  /** Renderer → main: re-read one profile's node-local binding now. */
  COPILOT_ACCOUNT_VERIFY_BINDING: 'copilot-account:verify-binding',
  /** Renderer → main: adopt the identity a profile is actually signed in as. */
  COPILOT_ACCOUNT_ADOPT_IDENTITY: 'copilot-account:adopt-identity',
  /** Renderer → main: routing rules for every profile. */
  COPILOT_ACCOUNT_RULE_LIST: 'copilot-account:rule-list',
  /** Renderer → main: add a repository/owner/path rule. */
  COPILOT_ACCOUNT_RULE_CREATE: 'copilot-account:rule-create',
  /** Renderer → main: delete a rule. Never rewrites an existing session stamp. */
  COPILOT_ACCOUNT_RULE_REMOVE: 'copilot-account:rule-remove',
  /** Renderer → main: which account a workspace would resolve to, and why. */
  COPILOT_ACCOUNT_PREVIEW_ROUTE: 'copilot-account:preview-route',
  /** Renderer → main: the GitHub remotes of a workspace, for rule suggestions. */
  COPILOT_ACCOUNT_SUGGEST_RULES: 'copilot-account:suggest-rules',
  /** Renderer → main: profile-by-node authentication matrix. */
  COPILOT_ACCOUNT_NODE_MATRIX: 'copilot-account:node-matrix',
  /**
   * Renderer → main: GitHub accounts Copilot is ALREADY signed in to on this
   * machine, that Harness has no profile for yet. Bounded identity metadata
   * only — the credentials stay where Copilot put them.
   */
  COPILOT_ACCOUNT_DISCOVER: 'copilot-account:discover',
  /** Renderer → main: the full Doctor report for the accounts section. */
  COPILOT_ACCOUNT_DIAGNOSTICS: 'copilot-account:diagnostics',
} as const;
