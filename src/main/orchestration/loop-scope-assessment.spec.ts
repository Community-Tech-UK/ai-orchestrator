/**
 * WS7 (loop-convergence plan) — pure plan-scope assessment.
 */

import { describe, expect, it } from 'vitest';
import {
  assessLoopScope,
  OVERSIZED_CHECKLIST_LEAF_COUNT,
} from './loop-scope-assessment';

/** Shaped after the real Fable implementation plan: an explicit
 * one-workstream sentence plus many WS headings. */
const FABLE_SHAPE = [
  '# Fable Implementation Plan',
  '',
  '**Approval note:** implement one workstream per run from this plan.',
  '',
  '## WS1 — Provider registration',
  '- [ ] register the adapter',
  '- [ ] add capability snapshot',
  '',
  '## WS2 — Model catalog',
  '- [ ] add model entries',
  '',
  '### WS3: Streaming runtime',
  '- [ ] wire the stream parser',
  '',
  '## Workstream 4 — Renderer picker',
  '- [ ] add to the picker',
].join('\n');

describe('assessLoopScope — dispositions', () => {
  it('FABLE SHAPE: explicit one-workstream rule + multiple WS headings → campaign-required', () => {
    const result = assessLoopScope(FABLE_SHAPE);
    expect(result.disposition).toBe('campaign-required');
    expect(result.reasons).toContain('explicit-one-workstream-rule');
    expect(result.reasons).toContain('multiple-workstreams');
    expect(result.workstreams.map((w) => w.id)).toEqual(['WS1', 'WS2', 'WS3', 'WS4']);
  });

  it('extracts titles and 1-indexed line ranges', () => {
    const result = assessLoopScope(FABLE_SHAPE);
    const ws1 = result.workstreams[0];
    expect(ws1.title).toBe('Provider registration');
    expect(ws1.startLine).toBe(5);
    // WS1 ends the line before WS2's heading (line 9).
    expect(ws1.endLine).toBe(8);
    const last = result.workstreams.at(-1)!;
    expect(last.endLine).toBeGreaterThanOrEqual(last.startLine);
  });

  it('multiple workstreams WITHOUT an explicit rule → campaign-recommended', () => {
    const text = FABLE_SHAPE.replace('**Approval note:** implement one workstream per run from this plan.', '');
    const result = assessLoopScope(text);
    expect(result.disposition).toBe('campaign-recommended');
    expect(result.reasons).toEqual(['multiple-workstreams']);
  });

  it('an oversized leaf checklist alone → campaign-recommended', () => {
    const items = Array.from(
      { length: OVERSIZED_CHECKLIST_LEAF_COUNT + 1 },
      (_, i) => `- [ ] step ${i}`,
    );
    const result = assessLoopScope(`# Big flat plan\n\n${items.join('\n')}\n`);
    expect(result.disposition).toBe('campaign-recommended');
    expect(result.reasons).toEqual(['oversized-checklist']);
    expect(result.checklistLeafCount).toBe(OVERSIZED_CHECKLIST_LEAF_COUNT + 1);
  });

  it('a small single-workstream plan → single-loop', () => {
    const result = assessLoopScope('# Plan\n\n## WS1 — Only one\n- [ ] a\n- [ ] b\n');
    expect(result.disposition).toBe('single-loop');
    expect(result.reasons).toEqual([]);
    expect(result.workstreams).toHaveLength(1);
  });

  it('a one-workstream rule with only ONE workstream is NOT campaign-required', () => {
    const result = assessLoopScope(
      '# Plan\nimplement one workstream per run.\n\n## WS1 — Solo\n- [ ] a\n',
    );
    expect(result.disposition).toBe('single-loop');
  });
});

describe('assessLoopScope — negative / adversarial cases', () => {
  it('prose mentioning "workstream" is not a heading', () => {
    const result = assessLoopScope(
      '# Plan\n\nThis workstream covers the parser. The other workstream ships later.\n- [ ] a\n',
    );
    expect(result.workstreams).toHaveLength(0);
    expect(result.disposition).toBe('single-loop');
  });

  it('fake headings inside code fences are ignored', () => {
    const result = assessLoopScope([
      '# Plan',
      '```md',
      '## WS1 — fake',
      '## WS2 — also fake',
      'implement one workstream per run',
      '- [ ] fenced checklist item',
      '```',
      '- [ ] real item',
    ].join('\n'));
    expect(result.workstreams).toHaveLength(0);
    expect(result.disposition).toBe('single-loop');
    expect(result.checklistLeafCount).toBe(1);
  });

  it('duplicate headings count once (malformed ordering cannot inflate the count)', () => {
    const result = assessLoopScope(
      '# Plan\n## WS2 — later first\n- [ ] a\n## WS2 — duplicate\n- [ ] b\n',
    );
    expect(result.workstreams).toHaveLength(1);
    expect(result.disposition).toBe('single-loop');
  });

  it('a large non-checklist document is single-loop', () => {
    const prose = Array.from({ length: 500 }, (_, i) => `Paragraph ${i} about the design.`);
    const result = assessLoopScope(`# Design notes\n\n${prose.join('\n\n')}\n`);
    expect(result.disposition).toBe('single-loop');
    expect(result.checklistLeafCount).toBe(0);
  });

  it('checklist leaves are counted from LEAF rows only (parents are structural)', () => {
    const result = assessLoopScope([
      '# Plan',
      '- [ ] parent',
      ...Array.from({ length: OVERSIZED_CHECKLIST_LEAF_COUNT }, (_, i) => `  - [ ] child ${i}`),
    ].join('\n'));
    // 40 leaves + structural parent → not oversized (leaf count = 40).
    expect(result.checklistLeafCount).toBe(OVERSIZED_CHECKLIST_LEAF_COUNT);
    expect(result.disposition).toBe('single-loop');
  });

  it('an empty document is single-loop', () => {
    expect(assessLoopScope('').disposition).toBe('single-loop');
  });
});
