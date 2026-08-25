/**
 * IPC channels for the Workspace Secret Card.
 *
 * These are DELIBERATELY separate from `INPUT_REQUIRED_RESPOND`. A secret typed by
 * the user must never travel a code path that can reach the agent CLI, the app log, or
 * conversation history — and `INPUT_REQUIRED_RESPOND` reaches all three
 * (`instance-handlers.ts` → `sendInputResponse` → `adapter.sendRaw`, with a response
 * preview logged on the way and a `user` message persisted to continuity).
 *
 * Branching inside that handler would make the guarantee conditional on nobody adding
 * another fall-through later. A separate channel makes it structural: there is no code
 * path from here to the CLI, so the invariant cannot be defeated by a later edit.
 *
 * Spec: docs/plans/2026-08-23-workspace-secret-card_spec_planned.md (§4, §5.3).
 */
export const SECRET_CHANNELS = {
  /** Renderer → main: the user pasted a value into the secure card. */
  SECRET_CARD_SUBMIT: 'secret-card:submit',
  /** Renderer → main: the user refused the request. Carries no value. */
  SECRET_CARD_DECLINE: 'secret-card:decline',
  /** Renderer → main: metadata for every secret in a workspace. Never values. */
  SECRET_CARD_LIST: 'secret-card:list',
  /** Renderer → main: delete a stored secret. */
  SECRET_CARD_FORGET: 'secret-card:forget',
  /** Renderer → main: audit trail for a workspace. Never values. */
  SECRET_CARD_AUDIT: 'secret-card:audit',
} as const;
