/**
 * Pure predicate that decides whether the Source Control entry point should
 * appear for the current dashboard state.
 *
 * Extracted so the rule can be unit-tested without Angular DI — mirrors the
 * pattern used by `instance-header-cursor.spec.ts` for the same reason.
 *
 * The four exclusion cases match the dead-ends the panel can't usefully
 * render today:
 *   - No selected instance → nothing to scan.
 *   - Chat is selected → the workspace view is in chat mode, not instance.
 *   - Benchmark mode → IPC may be unavailable.
 *   - Remote instance → git ops over remote shell are not implemented yet
 *     (tracked as Tier D in the Phase 2 plan).
 *   - Missing / empty working directory → nothing to scan.
 */
export interface SourceControlEligibilityInput {
  hasSelectedInstance: boolean;
  hasSelectedChat: boolean;
  isBenchmarkMode: boolean;
  isRemote: boolean;
  workingDirectory: string | null | undefined;
}

export function isSourceControlEligible(input: SourceControlEligibilityInput): boolean {
  if (!input.hasSelectedInstance) return false;
  if (input.hasSelectedChat) return false;
  if (input.isBenchmarkMode) return false;
  if (input.isRemote) return false;
  const wd = input.workingDirectory;
  if (!wd || wd.trim() === '') return false;
  return true;
}
