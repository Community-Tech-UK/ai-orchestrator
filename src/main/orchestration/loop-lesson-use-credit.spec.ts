import { beforeEach, describe, expect, it } from 'vitest';
import { creditSurfacedLessonUse } from './loop-lesson-use-credit';
import { getLessonStore, _resetLessonStoreForTesting } from '../memory/lesson-store';
import { _resetRecallTraceStoreForTesting, getRecallTraceStore } from '../memory/retrieval-eval/recall-trace-store';

describe('creditSurfacedLessonUse', () => {
  beforeEach(() => {
    _resetLessonStoreForTesting();
    _resetRecallTraceStoreForTesting();
  });

  it('reinforces surfaced lessons the terminal outcome echoes', () => {
    const store = getLessonStore();
    const mutex = store.capture('Acquire the session mutex before writing provider identity').lesson;
    const tests = store.capture('Run the quiet test runner for full suites').lesson;

    creditSurfacedLessonUse(
      [{ id: mutex.id, text: mutex.text }, { id: tests.id, text: tests.text }],
      'I acquired the session mutex before writing the provider identity to avoid the deadlock.',
    );

    expect(store.get(mutex.id)?.uses).toBe(1);
    expect(store.get(tests.id)?.uses).toBe(0); // not echoed
  });

  it('is a no-op with no surfaced lessons or empty outcome text', () => {
    const store = getLessonStore();
    const lesson = store.capture('some lesson').lesson;
    creditSurfacedLessonUse(undefined, 'text');
    creditSurfacedLessonUse([{ id: lesson.id, text: lesson.text }], '   ');
    expect(store.get(lesson.id)?.uses).toBe(0);
  });

  it('records the use against the lessons recall-trace surface when one exists', () => {
    const store = getLessonStore();
    const lesson = store.capture('macOS grep treats backslash pipe literally in alternation').lesson;
    getRecallTraceStore().record({
      surface: 'lessons',
      query: 'grep',
      returned: [{ id: lesson.id, score: 1 }],
    });

    creditSurfacedLessonUse(
      [{ id: lesson.id, text: lesson.text }],
      'macOS grep treats backslash pipe literally in alternation, so I read the file instead.',
    );

    expect(store.get(lesson.id)?.uses).toBe(1);
    expect(getRecallTraceStore().bySurface('lessons')[0].usedIds).toContain(lesson.id);
  });
});
