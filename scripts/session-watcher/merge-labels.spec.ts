import { describe, expect, it } from 'vitest';
import { mergeLabels } from './merge-labels';
import type { LabelRow, LabelValue } from './types';

const label = (id: string, labeller: string, value: LabelValue, outward = false): LabelRow => ({ id, labeller, label: value, basis: 'none', outward, note: `${labeller} note` });

describe('mergeLabels', () => {
  it('keeps the label where the labellers agree and ORs the outward flag', () => {
    const r = mergeLabels([label('s1', 'a', 'needs_user')], [label('s1', 'b', 'needs_user', true)]);
    expect(r.final).toEqual([{ id: 's1', label: 'needs_user', decidedBy: 'agreed', outward: true }]);
    expect(r.disputes).toEqual([]);
  });

  it('leaves every disagreement disputed, with both labels and notes', () => {
    const r = mergeLabels(
      [label('s1', 'a', 'needs_user', true), label('s2', 'a', 'finished')],
      [label('s1', 'b', 'carry_on_ok'), label('s2', 'b', 'carry_on_ok')],
    );
    expect(r.final).toEqual([]);
    expect(r.disputes.map((d) => d.id)).toEqual(['s1', 's2']);
    expect(r.disputes[0]).toMatchObject({ id: 's1', a: { label: 'needs_user', outward: true, note: 'a note' }, b: { label: 'carry_on_ok' } });
  });

  it('counts ids only one labeller covered and leaves them out', () => {
    const r = mergeLabels([label('s1', 'a', 'finished')], [label('s2', 'b', 'finished')]);
    expect(r.final).toEqual([]);
    expect(r.unpaired).toBe(2);
  });
});
