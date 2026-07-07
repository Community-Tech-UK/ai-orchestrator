import { describe, expect, it } from 'vitest';
import { diffLines } from './line-diff';

describe('diffLines', () => {
  it('marks added and removed lines around unchanged context', () => {
    const diff = diffLines('a\nb\nc', 'a\nB\nc');

    expect(diff.rows).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.truncated).toBe(false);
  });

  it('treats empty old text as a pure addition (Write tool)', () => {
    const diff = diffLines('', 'line 1\nline 2');

    expect(diff.rows).toEqual([
      { kind: 'add', text: 'line 1' },
      { kind: 'add', text: 'line 2' },
    ]);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
  });

  it('collapses long unchanged runs into a skip row', () => {
    const unchanged = Array.from({ length: 20 }, (_, i) => `same ${i}`).join('\n');
    const diff = diffLines(`start\n${unchanged}\nend`, `START\n${unchanged}\nend`);

    const skip = diff.rows.find((r) => r.kind === 'skip');
    expect(skip?.text).toContain('unchanged lines');
    // 3 context lines kept after the change, rest folded.
    const ctxCount = diff.rows.filter((r) => r.kind === 'ctx').length;
    expect(ctxCount).toBeLessThan(21);
  });

  it('flags truncation on pathological inputs instead of hanging', () => {
    const big = Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n');
    const diff = diffLines(big, `${big}\nextra`);

    expect(diff.truncated).toBe(true);
  });
});
