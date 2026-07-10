export const DOC_REVIEW_CHANNELS = {
  // Queries (renderer → main)
  /** List review sessions, optionally filtered by status. */
  DOC_REVIEW_LIST: 'doc-review:list',
  /** Get a single review session by id. */
  DOC_REVIEW_GET: 'doc-review:get',
  /** Read the validated artifact HTML for a session (re-validates the stored path). */
  DOC_REVIEW_READ_ARTIFACT: 'doc-review:read-artifact',

  // Commands (renderer → main)
  /** Submit James's decisions; renders the canonical feedback block into the instance. */
  DOC_REVIEW_SUBMIT_DECISION: 'doc-review:submit-decision',
  /** Dismiss a pending review without deciding it. */
  DOC_REVIEW_DISMISS: 'doc-review:dismiss',
  /** Open the artifact in the external browser (Phase 1 standalone mode inside the app). */
  DOC_REVIEW_OPEN_EXTERNAL: 'doc-review:open-external',

  // Events (main → renderer)
  /** A review session was created, decided, or dismissed. */
  DOC_REVIEW_CHANGED: 'doc-review:changed',
} as const;
