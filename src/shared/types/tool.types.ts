/**
 * Shared tool safety metadata.
 * Used by the orchestration layer to make scheduling decisions.
 */
export interface ToolSafetyMetadata {
  /** Can this tool run concurrently with other tools without conflict? */
  isConcurrencySafe: boolean;
  /** Does this tool have no observable side effects? */
  isReadOnly: boolean;
  /** Does this tool make irreversible changes (delete, overwrite)? */
  isDestructive: boolean;
  /** Approximate execution time hint for the scheduler (optional). */
  estimatedDurationMs?: number;
}
