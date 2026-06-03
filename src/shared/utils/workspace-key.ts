/**
 * Stable workspace identifier for grouping automations (and other
 * working-directory-scoped records) by project.
 *
 * The renderer groups instances into projects by a normalized
 * `workingDirectory` "project key" (trim + lowercase; empty -> sentinel) — see
 * `ProjectRailPathService.getProjectKey`. `toWorkspaceId` mirrors that
 * normalization for the non-scratch case so an automation's persisted
 * `workspaceId` lines up with the project key the UI computes for the same
 * directory.
 *
 * Keep this in sync with the SQL backfill in migration
 * `034_automation_workspace_id`:
 *   COALESCE(NULLIF(lower(trim(json_extract(action_json,'$.workingDirectory'))), ''), '__no_workspace__')
 */

/** Sentinel workspace id for automations with no working directory. */
export const NO_WORKSPACE_KEY = '__no_workspace__';

/**
 * Normalize a working directory into a stable workspace id.
 *
 * @param workingDirectory The automation's target directory (may be empty/null).
 * @returns The lowercased, trimmed path, or {@link NO_WORKSPACE_KEY} when blank.
 */
export function toWorkspaceId(workingDirectory?: string | null): string {
  const normalized = (workingDirectory ?? '').trim();
  return normalized ? normalized.toLowerCase() : NO_WORKSPACE_KEY;
}
