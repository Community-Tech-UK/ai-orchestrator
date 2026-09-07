/**
 * N4 — structured fresh-eyes findings, instead of one flattened sentence.
 *
 * When a fresh-eyes review blocks a loop, the activity feed shows a single
 * line: every finding's title joined by semicolons. The severity, the file, the
 * cited line range and the quote that justifies the finding all crossed IPC
 * intact and were then thrown away at render time. An operator deciding whether
 * to accept or fix a blocking finding needs the citation, not the headline.
 *
 * Two pure helpers, both deliberately defensive about the untyped `detail`
 * field an activity carries.
 */

import type { FreshEyesFindingSummary } from '../../core/services/ipc/loop-ipc.service';

export interface FreshEyesFindingsDetail {
  signal: string;
  blockingFindings: FreshEyesFindingSummary[];
  demotedFindings: FreshEyesFindingSummary[];
  summary?: string;
}

function isFinding(value: unknown): value is FreshEyesFindingSummary {
  return !!value && typeof value === 'object' && typeof (value as { title?: unknown }).title === 'string';
}

/**
 * Narrow an activity's untyped `detail` into findings, or null.
 *
 * Checks the actual field shapes rather than trusting `kind === 'input_required'`
 * alone: that kind string is generic, and a future unrelated activity reusing it
 * should degrade to "no panel" rather than crash the feed.
 */
export function freshEyesFindingsDetail(detail: unknown): FreshEyesFindingsDetail | null {
  if (!detail || typeof detail !== 'object') return null;
  const record = detail as Record<string, unknown>;
  if (!Array.isArray(record['blockingFindings'])) return null;

  const blockingFindings = record['blockingFindings'].filter(isFinding);
  if (blockingFindings.length === 0) return null;

  const demoted = Array.isArray(record['demotedFindings'])
    ? record['demotedFindings'].filter(isFinding)
    : [];

  return {
    signal: typeof record['signal'] === 'string' ? record['signal'] : '',
    blockingFindings,
    demotedFindings: demoted,
    ...(typeof record['summary'] === 'string' ? { summary: record['summary'] } : {}),
  };
}

/** Where a finding points, as one readable string. */
export function findingLocation(finding: FreshEyesFindingSummary): string {
  const file = finding.anchor?.file ?? finding.file;
  if (!file) return '';
  const range = finding.anchor?.lineRange;
  if (!range) return file;
  const [start, end] = range;
  return start === end ? `${file}:${start}` : `${file}:${start}–${end}`;
}

/**
 * The intervention text sent when the operator asks for selected findings to be
 * fixed.
 *
 * Deliberately mirrors the wording the completion gate already uses when it
 * injects a blocking-findings intervention automatically, so a manual fix and
 * an automatic one read the same way in the transcript — an operator reading
 * back through a run should not have to work out which of the two happened.
 */
export function buildFixSelectedMessage(findings: readonly FreshEyesFindingSummary[]): string {
  if (findings.length === 0) return '';
  const lines = findings.map((finding) => {
    const where = findingLocation(finding);
    const severity = finding.severity ? `[${finding.severity}] ` : '';
    const body = finding.body ? `\n  ${finding.body}` : '';
    const quote = finding.anchor?.quote ? `\n  cited: "${finding.anchor.quote}"` : '';
    return `- ${severity}${finding.title}${where ? ` (${where})` : ''}${body}${quote}`;
  });
  const count = findings.length;
  return `Fix the following ${count} blocking review finding${count === 1 ? '' : 's'}, `
    + `then continue:\n${lines.join('\n')}`;
}
