import type {
  OperatorProjectRecord,
  OperatorVerificationCheckResult,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';

const DEFAULT_MAX_SECTION_CHARS = 4_000;

export interface OperatorFixWorkerPromptInput {
  originalGoal: string;
  project: OperatorProjectRecord;
  attempt: number;
  previousWorkerOutputPreview: string | null;
  verification: OperatorVerificationSummary;
  maxSectionChars?: number;
}

export function buildOperatorFixWorkerPrompt(input: OperatorFixWorkerPromptInput): string {
  const maxSectionChars = input.maxSectionChars ?? DEFAULT_MAX_SECTION_CHARS;
  const requiredFailures = input.verification.checks.filter((check) =>
    check.required && check.status === 'failed'
  );
  const optionalFailures = input.verification.checks.filter((check) =>
    !check.required && check.status === 'failed'
  );

  return [
    'You are continuing a global Operator run for a project.',
    '',
    'Original user request:',
    truncateSection(input.originalGoal, maxSectionChars),
    '',
    'Project:',
    input.project.displayName,
    input.project.canonicalPath,
    '',
    'Repair attempt:',
    String(input.attempt),
    '',
    'Previous worker output:',
    truncateSection(input.previousWorkerOutputPreview ?? 'No output preview was captured.', maxSectionChars),
    '',
    'Required verification failures:',
    formatCheckList(requiredFailures, maxSectionChars),
    '',
    'Optional verification failures:',
    formatCheckList(optionalFailures, maxSectionChars),
    '',
    'Make the smallest change that addresses the required verification failures.',
    'Run the relevant checks when practical.',
    'The Operator will independently rerun verification after you finish.',
  ].join('\n');
}

function formatCheckList(checks: OperatorVerificationCheckResult[], maxSectionChars: number): string {
  if (checks.length === 0) {
    return 'None.';
  }

  return checks.map((check) => formatCheck(check, maxSectionChars)).join('\n\n');
}

function formatCheck(check: OperatorVerificationCheckResult, maxSectionChars: number): string {
  const commandLine = [check.command, ...check.args].join(' ');
  return [
    `- ${check.label}`,
    `  Command: ${commandLine}`,
    `  Cwd: ${check.cwd}`,
    `  Exit code: ${check.exitCode === null ? 'null' : check.exitCode}`,
    `  Timed out: ${check.timedOut}`,
    `  Error: ${check.error ?? 'none'}`,
    '  Stdout:',
    indentBlock(truncateSection(check.stdoutExcerpt || '(empty)', maxSectionChars), '    '),
    '  Stderr:',
    indentBlock(truncateSection(check.stderrExcerpt || '(empty)', maxSectionChars), '    '),
  ].join('\n');
}

function truncateSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = '\n[truncated]\n';
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available / 2);
  const tail = Math.floor(available / 2);
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function indentBlock(value: string, prefix: string): string {
  return value.split('\n').map((line) => `${prefix}${line}`).join('\n');
}
