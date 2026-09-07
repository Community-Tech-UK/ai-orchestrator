/**
 * N4 — the narrowing helper is the risky half: it reads an activity's untyped
 * `detail` field, and the `input_required` kind string it arrives under is
 * generic enough that some future unrelated activity will reuse it. Degrading
 * to null there is the difference between "no panel" and a crashed feed.
 */
import { describe, expect, it } from 'vitest';

import {
  buildFixSelectedMessage,
  findingLocation,
  freshEyesFindingsDetail,
} from './loop-fresh-eyes-findings-panel.util';
import type { FreshEyesFindingSummary } from '../../core/services/ipc/loop-ipc.service';

const finding = (over: Partial<FreshEyesFindingSummary> = {}): FreshEyesFindingSummary => ({
  title: 'Null deref in the parser',
  ...over,
});

describe('freshEyesFindingsDetail', () => {
  it('returns null for a non-object detail', () => {
    expect(freshEyesFindingsDetail(undefined)).toBeNull();
    expect(freshEyesFindingsDetail(null)).toBeNull();
    expect(freshEyesFindingsDetail('a string')).toBeNull();
  });

  /** The whole point: an unrelated activity reusing the kind must not crash. */
  it('returns null for a detail with no findings array', () => {
    expect(freshEyesFindingsDetail({ signal: 'x', somethingElse: 1 })).toBeNull();
  });

  it('returns null when the findings array is empty', () => {
    expect(freshEyesFindingsDetail({ blockingFindings: [] })).toBeNull();
  });

  it('drops entries that are not findings rather than trusting the array', () => {
    const detail = freshEyesFindingsDetail({
      blockingFindings: [finding(), null, 42, { noTitle: true }],
    });
    expect(detail?.blockingFindings).toHaveLength(1);
  });

  it('carries the signal, summary and demoted findings through', () => {
    const detail = freshEyesFindingsDetail({
      signal: 'blocking-findings',
      summary: 'Two problems.',
      blockingFindings: [finding()],
      demotedFindings: [finding({ title: 'Almost blocked', demotedReason: 'anchor not verified' })],
    });
    expect(detail?.signal).toBe('blocking-findings');
    expect(detail?.summary).toBe('Two problems.');
    expect(detail?.demotedFindings[0]?.demotedReason).toBe('anchor not verified');
  });

  it('treats missing demoted findings as none, not as an error', () => {
    expect(freshEyesFindingsDetail({ blockingFindings: [finding()] })?.demotedFindings).toEqual([]);
  });
});

describe('findingLocation', () => {
  it('is blank when the finding cites nothing', () => {
    expect(findingLocation(finding())).toBe('');
  });

  it('falls back to the finding’s own file', () => {
    expect(findingLocation(finding({ file: 'src/a.ts' }))).toBe('src/a.ts');
  });

  it('prefers the anchor’s file over the finding’s', () => {
    expect(findingLocation(finding({
      file: 'src/a.ts',
      anchor: { file: 'src/b.ts', quote: 'x' },
    }))).toBe('src/b.ts');
  });

  it('renders a single cited line without a range', () => {
    expect(findingLocation(finding({ anchor: { file: 'src/a.ts', lineRange: [12, 12], quote: 'x' } })))
      .toBe('src/a.ts:12');
  });

  it('renders a real range', () => {
    expect(findingLocation(finding({ anchor: { file: 'src/a.ts', lineRange: [12, 18], quote: 'x' } })))
      .toBe('src/a.ts:12–18');
  });
});

describe('buildFixSelectedMessage', () => {
  it('is empty for no findings, so nothing can be sent by accident', () => {
    expect(buildFixSelectedMessage([])).toBe('');
  });

  it('counts the findings in the instruction', () => {
    expect(buildFixSelectedMessage([finding()])).toContain('1 blocking review finding,');
    expect(buildFixSelectedMessage([finding(), finding()])).toContain('2 blocking review findings,');
  });

  it('includes severity, location, body and the citation', () => {
    const message = buildFixSelectedMessage([finding({
      severity: 'high',
      body: 'The parser assumes a node exists.',
      anchor: { file: 'src/parse.ts', lineRange: [40, 42], quote: 'node.value' },
    })]);
    expect(message).toContain('[high]');
    expect(message).toContain('src/parse.ts:40–42');
    expect(message).toContain('The parser assumes a node exists.');
    expect(message).toContain('cited: "node.value"');
  });

  it('omits the parts a finding does not have rather than printing blanks', () => {
    const message = buildFixSelectedMessage([finding()]);
    expect(message).not.toContain('[]');
    expect(message).not.toContain('()');
    expect(message).not.toContain('cited:');
  });

  it('lists every selected finding', () => {
    const message = buildFixSelectedMessage([finding({ title: 'One' }), finding({ title: 'Two' })]);
    expect(message).toContain('- One');
    expect(message).toContain('- Two');
  });
});
