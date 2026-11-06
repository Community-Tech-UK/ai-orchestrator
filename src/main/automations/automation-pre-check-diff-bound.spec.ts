/**
 * R5M1 / W2: the change note's line diff must be bounded in time.
 *
 * The diff library's edit-distance search is quadratic on a 16 KB baseline
 * against up to 1 MB of very different output (`seq 1 30000` took 10.9 s in the
 * main process). These specs pin two things: ordinary changes still produce the
 * exact text the unbounded call produced, and the worst 1 MB shapes finish
 * quickly with a plain fallback sentence instead.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CHECK_OUTPUT_MAX_CHARS, type AutomationCheckState } from './automation-check-store';

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-pre-check-bound-userdata-'));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

import {
  buildChangeDiff,
  hashCheckOutput,
  normalizeCheckOutput,
  runAutomationPreCheck,
} from './automation-pre-check';

const MB = 1024 * 1024;
/** Spec for "about 250 ms" with headroom for a loaded CI host; the unbounded call took 10 s or more. */
const TIMING_GUARD_MS = 600;
const FALLBACK = 'was too large to show the difference';

/** The code that shipped before the bound: unbounded diff, then the 4,000-character cap. */
function unboundedChangeDiff(baseline: string, current: string): string {
  const diff = createTwoFilesPatch('previous', 'current', baseline, current, undefined, undefined);
  return diff.length > 4_000 ? `${diff.slice(0, 4_000)}\n… (diff truncated)` : diff;
}

/** Small deterministic generator so the varied inputs are the same on every run. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function numberedLines(count: number, tag: string, width = 5): string {
  return Array.from({ length: count }, (_, i) => `${tag}${String(i).padStart(width, '0')}`).join('\n');
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

describe('buildChangeDiff (R5M1 / W2)', () => {
  afterAll(() => fs.rmSync(userDataDir, { recursive: true, force: true }));

  describe('ordinary changes are byte-identical to the unbounded diff', () => {
    const fixed: [string, string, string][] = [
      ['one line changed', '41 messages, newest uid 18234', '43 messages, newest uid 18236'],
      ['empty baseline', '', 'first\nsecond\nthird'],
      ['empty current', 'first\nsecond', ''],
      ['append a line', 'a\nb\nc', 'a\nb\nc\nd'],
      ['remove first line', 'a\nb\nc', 'b\nc'],
      ['no trailing newline then trailing newline', 'a\nb', 'a\nb\n'],
      ['crlf versus lf', 'a\r\nb\r\nc', 'a\nb\nc'],
      ['unicode and emoji', 'café ☃\nline', 'café ☃\nline two \u{1F600}'],
      ['line separators', 'a b c', 'a B c'],
      ['single long line changed', 'x'.repeat(8_000), `${'x'.repeat(7_999)}y`],
      ['all lines different, 3 KB', numberedLines(400, 'a', 6), numberedLines(400, 'b', 6)],
      ['identical text', 'same\ntext', 'same\ntext'],
    ];
    for (const [name, baseline, current] of fixed) {
      it(`matches for: ${name}`, () => {
        expect(buildChangeDiff(baseline, current)).toBe(unboundedChangeDiff(baseline, current));
      });
    }

    it('matches over 300 generated edits of a baseline, including the 4,000-character truncation', () => {
      const random = prng(20261020);
      let truncated = 0;
      let multiHunk = 0;
      for (let round = 0; round < 300; round++) {
        const lineCount = 1 + Math.floor(random() * 900);
        const baselineLines = Array.from({ length: lineCount }, (_, i) =>
          `row ${i} value ${Math.floor(random() * 1000)} ${'z'.repeat(Math.floor(random() * 30))}`);
        const currentLines = [...baselineLines];
        const edits = 1 + Math.floor(random() * 12);
        for (let edit = 0; edit < edits; edit++) {
          const at = Math.floor(random() * (currentLines.length + 1));
          const kind = random();
          if (kind < 0.4) currentLines.splice(at, 1);
          else if (kind < 0.7) currentLines.splice(at, 0, `inserted ${round} ${edit}`);
          else currentLines[at] = `changed ${round} ${edit}`;
        }
        const baseline = normalizeCheckOutput(baselineLines.join('\n')).slice(0, CHECK_OUTPUT_MAX_CHARS);
        const current = normalizeCheckOutput(currentLines.join('\n'));
        const expected = unboundedChangeDiff(baseline, current);
        if (expected.endsWith('… (diff truncated)')) truncated++;
        if ((expected.match(/^@@/gm) ?? []).length > 1) multiHunk++;
        expect(buildChangeDiff(baseline, current)).toBe(expected);
      }
      // The sample really did exercise both the cap and multi-hunk output.
      expect(truncated).toBeGreaterThan(10);
      expect(multiHunk).toBeGreaterThan(10);
    });
  });

  describe('1 MB timing guards', () => {
    const baseline = numberedLines(1500, 'old').slice(0, CHECK_OUTPUT_MAX_CHARS);

    it('a fully different 1 MB output gives the plain fallback quickly', () => {
      const current = numberedLines(130_000, 'new').slice(0, MB);
      const { value, ms } = timed(() => buildChangeDiff(baseline, current));
      expect(ms).toBeLessThan(TIMING_GUARD_MS);
      expect(value).toContain(FALLBACK);
      expect(value.length).toBeLessThanOrEqual(4_000);
    });

    it('seq-like 1 MB output gives the plain fallback quickly', () => {
      const current = Array.from({ length: 200_000 }, (_, i) => String(i + 1)).join('\n').slice(0, MB);
      const { value, ms } = timed(() => buildChangeDiff(baseline, current));
      expect(ms).toBeLessThan(TIMING_GUARD_MS);
      expect(value).toContain(FALLBACK);
    });

    it('a single 1 MB line stays fast and still capped at 4,000 characters', () => {
      const current = 'x'.repeat(MB);
      const { value, ms } = timed(() => buildChangeDiff(baseline, current));
      expect(ms).toBeLessThan(TIMING_GUARD_MS);
      expect(value.length).toBeLessThanOrEqual(4_000 + '\n… (diff truncated)'.length);
    });

    it('1 MB of one-character lines stays fast', () => {
      const current = 'a\n'.repeat(MB / 2);
      const { ms } = timed(() => buildChangeDiff(baseline, current));
      expect(ms).toBeLessThan(TIMING_GUARD_MS);
    });
  });

  describe('through runAutomationPreCheck', () => {
    it('keeps the change-note shape and returns the fallback for a huge different output', async () => {
      const baselineOutput = numberedLines(1500, 'old').slice(0, CHECK_OUTPUT_MAX_CHARS);
      const state: AutomationCheckState = {
        automationId: 'a1',
        baselineHash: hashCheckOutput(normalizeCheckOutput(baselineOutput)),
        baselineOutput,
        baselineAt: 1_700_000_000_000,
        pendingRunId: null,
        pendingHash: null,
        pendingOutput: null,
        failureStreak: 0,
        updatedAt: 1,
      };
      const started = performance.now();
      const result = await runAutomationPreCheck(
        // About 0.9 MB of output, the shape that took 36 s before the bound.
        { command: 'seq 1 150000' },
        {
          cwd: os.tmpdir(),
          automationId: 'a1',
          store: { getState: () => state },
          now: () => 1_700_000_000_000,
        },
      );
      const elapsed = performance.now() - started;
      expect(result.kind).toBe('changed');
      // The login shell and `seq` are in this number, so it is looser than the unit guard.
      expect(elapsed).toBeLessThan(5_000);
      const note = result.note ?? '';
      expect(note.startsWith('<automation_check_result>\n')).toBe(true);
      expect(note).toContain('Change since then:\n');
      expect(note).toContain(FALLBACK);
      expect(note).toContain('</automation_check_result>\nStart from the change above.');
    }, 20_000);
  });
});
