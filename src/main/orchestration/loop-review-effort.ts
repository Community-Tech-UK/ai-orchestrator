const SENSITIVE_PATH = /(?:^|[/. _-])(?:auth(?:entication|orization)?|security|secrets?|credentials?|permissions?|sandbox|migrations?|schemas?|preload|ipc|contracts|ci|deploy|infra|docker)(?:[/. _-]|$)|(?:^|\/)\.github(?:\/|$)|(?:^|\/)\.env[^/]*$|(?:^|\/)(?:package(?:-lock)?\.json|[a-z-]*lock\.(?:yaml|json)|yarn\.lock|bun\.lockb?)$/i;
export interface LoopReviewEffort { level: 'light' | 'standard'; reason: string }
export function resolveLoopReviewEffort(input: { files?: readonly string[]; changedLines?: number }): LoopReviewEffort {
  const files = input.files;
  if (!files || files.length === 0 || input.changedLines === undefined || !Number.isFinite(input.changedLines) || input.changedLines < 0) return { level: 'standard', reason: 'The change size is unknown.' };
  if (files.some((file) => SENSITIVE_PATH.test(file.replace(/\\/g, '/')))) return { level: 'standard', reason: 'The change touches sensitive files.' };
  if (files.length > 3 || input.changedLines >= 50) return { level: 'standard', reason: `${input.changedLines} changed lines in ${files.length} files.` };
  return { level: 'light', reason: `${input.changedLines} changed lines in ${files.length} files, no sensitive files` };
}
