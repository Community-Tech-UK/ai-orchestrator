/**
 * Which tool results count as failed, mirroring the desktop's one rule
 * (`src/shared/tool-outcome.ts`) so phone and desktop agree. The phone cannot
 * import that module at run time, so `tool-result-outcome-parity.spec.ts` compares
 * the two and fails when they drift.
 *
 * A command's `is_error` only means it could not run. A command that ran and
 * exited non-zero is neutral (a search that found nothing exits 1); only a check
 * (tests, lint, a build) that did not pass is a failure, and the desktop marks that
 * `checkFailed`. Reading `is_error` alone would hide a failed test on the phone.
 */

/** Tools whose result fails only on `is_error`; the check flags never apply to them. */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'apply_patch', 'patch', 'edit_file', 'write_file', 'editfile', 'createfile', 'file_change',
]);

type Metadata = Record<string, unknown> | undefined;

function checkDidNotPass(metadata: Record<string, unknown>): boolean {
  if (typeof metadata['checkFailed'] === 'boolean') return metadata['checkFailed'];
  const exitCode = metadata['exitCode'];
  return metadata['isCheck'] === true && typeof exitCode === 'number' && exitCode !== 0;
}

/** Whether a finished tool call counts as failed: it errored, or it was a check that did not pass. */
export function toolResultFailed(toolName: string | undefined, metadata: Metadata): boolean {
  if (!metadata) return false;
  if (metadata['is_error'] === true || metadata['isError'] === true) return true;
  const name = toolName?.trim().toLowerCase();
  return !(name && EDIT_TOOL_NAMES.has(name)) && checkDidNotPass(metadata);
}

/** The neutral line for a command that ended with a non-zero status. Nothing for a clean exit or none reported. */
export function exitStatusLine(metadata: Metadata): string | undefined {
  const exitCode = metadata?.['exitCode'];
  return typeof exitCode === 'number' && exitCode !== 0 ? `Exited with status ${exitCode}` : undefined;
}
