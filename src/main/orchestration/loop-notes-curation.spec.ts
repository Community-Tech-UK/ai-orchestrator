/**
 * LF-3 (loopfixex §LF-3) — NOTES.md curation + cost-cap default.
 *
 * NOTES.md is agent-maintained, re-read every iteration, and otherwise
 * unbounded. `curateNotesContent` bounds it on long runs while preserving the
 * `## Completion Inventory` section verbatim (the durable work ledger).
 */

import { describe, expect, it } from 'vitest';
import { curateNotesContent } from './loop-stage-machine';
import { defaultLoopConfig } from '../../shared/types/loop.types';

const INVENTORY = [
  '## Completion Inventory',
  '- [x] Wire the adapter',
  '- [ ] Add the reset rule',
  '- [ ] Surface the toggle',
].join('\n');

function bigNotes(entryCount: number): string {
  const entries: string[] = ['# Loop Notes', ''];
  for (let i = 0; i < entryCount; i++) {
    entries.push(`## Iteration ${i}`);
    entries.push(`Did some work in iteration ${i}. ${'x'.repeat(400)}`);
    entries.push('');
  }
  return entries.join('\n');
}

describe('curateNotesContent (LF-3)', () => {
  it('leaves small notes untouched', () => {
    const small = '# Loop Notes\n\nShort note.\n';
    const result = curateNotesContent(small, { maxChars: 24_000 });
    expect(result.changed).toBe(false);
    expect(result.curated).toBe(small);
    expect(result.elidedChars).toBe(0);
  });

  it('bounds an oversized NOTES.md and keeps the recent tail', () => {
    const content = bigNotes(200) + '\n## Iteration LAST\nFinal recent note marker.\n';
    expect(content.length).toBeGreaterThan(24_000);

    const result = curateNotesContent(content, { maxChars: 24_000, keepTailChars: 6_000 });

    expect(result.changed).toBe(true);
    expect(result.elidedChars).toBeGreaterThan(0);
    expect(result.curated.length).toBeLessThan(content.length);
    // Recent entries survive verbatim…
    expect(result.curated).toContain('Final recent note marker.');
    // …an early entry is elided…
    expect(result.curated).not.toContain('Did some work in iteration 0.');
    // …and the elision is announced + points at the durable log.
    expect(result.curated).toContain('ITERATION_LOG.md');
    expect(result.curated.startsWith('# Loop Notes')).toBe(true);
  });

  it('preserves the Completion Inventory byte-for-byte when it would otherwise be elided', () => {
    // Inventory at the TOP (the elided region), bulk recent notes after it.
    const content = `# Loop Notes\n\n${INVENTORY}\n\n` + bigNotes(200);
    expect(content.length).toBeGreaterThan(24_000);

    const result = curateNotesContent(content, { maxChars: 24_000, keepTailChars: 6_000 });

    expect(result.changed).toBe(true);
    expect(result.curated).toContain(INVENTORY);
  });

  it('does not duplicate the Completion Inventory when it is already in the retained tail', () => {
    const content = bigNotes(200) + `\n\n${INVENTORY}\n`;
    const result = curateNotesContent(content, { maxChars: 24_000, keepTailChars: 8_000 });

    expect(result.changed).toBe(true);
    const occurrences = result.curated.split('## Completion Inventory').length - 1;
    expect(occurrences).toBe(1);
    expect(result.curated).toContain(INVENTORY);
  });
});

describe('defaultLoopConfig cost cap (LF-3)', () => {
  it('defaults maxCostCents to $10 (1000 cents)', () => {
    const cfg = defaultLoopConfig('/tmp/ws', 'goal');
    expect(cfg.caps.maxCostCents).toBe(1000);
  });
});
