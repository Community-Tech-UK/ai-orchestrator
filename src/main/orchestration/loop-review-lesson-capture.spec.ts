/**
 * Fable WS6 Task 4 — review/debate lesson capture.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  captureReviewLesson,
  type ReviewLessonDeps,
  type ReviewLessonInput,
} from './loop-review-lesson-capture';

function input(over: Partial<ReviewLessonInput> = {}): ReviewLessonInput {
  return {
    kind: 'fresh-eyes',
    goal: 'implement the widget',
    reviewers: ['codex'],
    findings: [
      { title: 'Missing null guard', body: 'widget() dereferences cfg before checking it', severity: 'high', file: 'src/widget.ts' },
    ],
    ...over,
  };
}

function deps(over: Partial<ReviewLessonDeps> = {}): ReviewLessonDeps {
  return {
    distill: async () => ({ text: 'Guard config objects before dereferencing them.', source: 'primary' }),
    captureLesson: vi.fn(() => ({ reinforced: false })),
    ...over,
  };
}

describe('captureReviewLesson', () => {
  it('distills and captures a one-line lesson from blocking findings', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(input(), deps({ captureLesson }));
    expect(res).not.toBeNull();
    expect(res!.lesson).toBe('Guard config objects before dereferencing them.');
    expect(res!.kind).toBe('fresh-eyes');
    expect(captureLesson).toHaveBeenCalledWith('Guard config objects before dereferencing them.');
  });

  it('passes goal, kind, findings, and reviewers into the distill prompt', async () => {
    const distill = vi.fn(async (_sys: string, _user: string) => ({ text: 'A lesson.', source: 'primary' }));
    await captureReviewLesson(input({ kind: 'ping-pong', reviewers: ['gemini'] }), deps({ distill }));
    const userPrompt = distill.mock.calls[0][1];
    expect(userPrompt).toContain('implement the widget');
    expect(userPrompt).toContain('ping-pong review (gemini)');
    expect(userPrompt).toContain('Missing null guard');
    expect(userPrompt).toContain('src/widget.ts');
  });

  it('returns null (captures nothing) when there are no findings and no summary', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(input({ findings: [] }), deps({ captureLesson }));
    expect(res).toBeNull();
    expect(captureLesson).not.toHaveBeenCalled();
  });

  it('skips capture when the aux slot fell back (no real model ran)', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(
      input(),
      deps({ distill: async () => ({ text: 'canned fallback text', source: 'fallback' }), captureLesson }),
    );
    expect(res).toBeNull();
    expect(captureLesson).not.toHaveBeenCalled();
  });

  it('skips capture when the model declines with NONE', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(
      input(),
      deps({ distill: async () => ({ text: '  none  ', source: 'primary' }), captureLesson }),
    );
    expect(res).toBeNull();
    expect(captureLesson).not.toHaveBeenCalled();
  });

  it('strips wrapping quotes, collapses whitespace, and caps length', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const messy = `"Always   ${'x'.repeat(400)}"`;
    const res = await captureReviewLesson(input(), deps({ distill: async () => ({ text: messy, source: 'primary' }), captureLesson }));
    expect(res).not.toBeNull();
    expect(res!.lesson.length).toBeLessThanOrEqual(200);
    expect(res!.lesson.startsWith('Always')).toBe(true);
    expect(res!.lesson).not.toContain('"');
  });

  it('propagates the store reinforced flag', async () => {
    const res = await captureReviewLesson(input(), deps({ captureLesson: () => ({ reinforced: true }) }));
    expect(res!.reinforced).toBe(true);
  });

  it('degrades to null (never throws) when the distiller throws', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(
      input(),
      deps({ distill: async () => { throw new Error('aux offline'); }, captureLesson }),
    );
    expect(res).toBeNull();
    expect(captureLesson).not.toHaveBeenCalled();
  });

  it('captures from a debate summary even with no discrete findings', async () => {
    const captureLesson = vi.fn(() => ({ reinforced: false }));
    const res = await captureReviewLesson(
      input({ kind: 'debate', findings: [], summary: 'The two models disagreed on locking; the reentrant path deadlocks.' }),
      deps({ captureLesson }),
    );
    expect(res).not.toBeNull();
    expect(captureLesson).toHaveBeenCalledTimes(1);
  });
});
