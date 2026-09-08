import { describe, expect, it } from 'vitest';
import { LOOP_MODE_HELP } from './loop.help';

function listItems(heading: string): readonly string[] {
  const section = LOOP_MODE_HELP.sections.find(
    (entry) => entry.kind === 'list' && entry.heading === heading,
  );
  if (!section || section.kind !== 'list') {
    throw new Error(`Missing list section: ${heading}`);
  }
  return section.items;
}

describe('LOOP_MODE_HELP (L15)', () => {
  it('does not claim every cap takes a wrap-up iteration', () => {
    const items = listItems('When the loop stops');
    expect(items.some((item) => /Every tripped cap currently takes/.test(item))).toBe(false);
    expect(items.some((item) => /token or cost cap stops immediately/.test(item))).toBe(true);
  });

  it('explains the degraded replay-unsafe pause', () => {
    const items = listItems('When the loop stops');
    expect(items.some((item) => /replay would be unsafe/.test(item))).toBe(true);
    expect(items.some((item) => /not the loop being stuck/.test(item))).toBe(true);
  });
});
