/**
 * Graceful-quit budgets. History archive of large live sessions is the slow
 * path on shutdown; the overall force-quit must outlast that work.
 */
export const CLEANUP_TIMEOUT_MS = 60_000;
export const TERMINATE_INSTANCES_BUDGET_MS = 50_000;
