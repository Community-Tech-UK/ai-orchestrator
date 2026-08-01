import { beforeEach, describe, expect, it } from 'vitest';
import { DiffReviewDraftStore } from './diff-review-draft.store';
import type { DiffAnnotationDraft } from '../../../../shared/types/diff-annotation.types';

function draft(overrides: Partial<DiffAnnotationDraft> = {}): DiffAnnotationDraft {
  return {
    path: 'src/x.ts',
    side: 'new',
    lineRange: { start: 5, end: 6 },
    excerpt: 'line-a\nline-b',
    comment: 'fix this',
    ...overrides,
  };
}

describe('DiffReviewDraftStore', () => {
  let store: DiffReviewDraftStore;

  beforeEach(() => {
    store = new DiffReviewDraftStore();
  });

  it('starts with an empty draft for any instance', () => {
    expect(store.annotationsFor('inst-1')).toEqual([]);
  });

  it('add() appends a fresh annotation with generated id/timestamps', () => {
    const created = store.add('inst-1', draft());
    expect(created.state).toBe('fresh');
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBeGreaterThan(0);
    expect(store.annotationsFor('inst-1')).toEqual([created]);
  });

  it('keeps drafts isolated per instance', () => {
    store.add('inst-1', draft({ path: 'a.ts' }));
    store.add('inst-2', draft({ path: 'b.ts' }));
    expect(store.annotationsFor('inst-1').map((a) => a.path)).toEqual(['a.ts']);
    expect(store.annotationsFor('inst-2').map((a) => a.path)).toEqual(['b.ts']);
  });

  it('annotationsForFile() filters by path within an instance', () => {
    store.add('inst-1', draft({ path: 'a.ts' }));
    store.add('inst-1', draft({ path: 'b.ts' }));
    expect(store.annotationsForFile('inst-1', 'a.ts').map((a) => a.path)).toEqual(['a.ts']);
  });

  it('updateComment() edits only the targeted annotation', () => {
    const first = store.add('inst-1', draft({ comment: 'one' }));
    const second = store.add('inst-1', draft({ comment: 'two' }));
    store.updateComment('inst-1', first.id, 'one-edited');
    const list = store.annotationsFor('inst-1');
    expect(list.find((a) => a.id === first.id)?.comment).toBe('one-edited');
    expect(list.find((a) => a.id === second.id)?.comment).toBe('two');
  });

  it('remove() drops only the targeted annotation', () => {
    const first = store.add('inst-1', draft());
    const second = store.add('inst-1', draft());
    store.remove('inst-1', first.id);
    expect(store.annotationsFor('inst-1').map((a) => a.id)).toEqual([second.id]);
  });

  it('clear() empties the draft for that instance only', () => {
    store.add('inst-1', draft());
    store.add('inst-2', draft());
    store.clear('inst-1');
    expect(store.annotationsFor('inst-1')).toEqual([]);
    expect(store.annotationsFor('inst-2').length).toBe(1);
  });

  describe('reconcile()', () => {
    it('re-anchors a matching annotation to a shifted range and flips its state', () => {
      const created = store.add('inst-1', draft({ path: 'x.ts', side: 'new', lineRange: { start: 5, end: 6 }, excerpt: 'line-a\nline-b' }));
      store.reconcile('inst-1', 'x.ts', 'new', [
        { lineNumber: 8, text: 'line-a' },
        { lineNumber: 9, text: 'line-b' },
      ]);
      const updated = store.annotationsFor('inst-1').find((a) => a.id === created.id);
      expect(updated?.state).toBe('re-anchored');
      expect(updated?.lineRange).toEqual({ start: 8, end: 9 });
    });

    it('marks an annotation stale when its excerpt no longer matches', () => {
      const created = store.add('inst-1', draft({ path: 'x.ts', side: 'new', excerpt: 'line-a\nline-b' }));
      store.reconcile('inst-1', 'x.ts', 'new', [{ lineNumber: 1, text: 'gone' }]);
      const updated = store.annotationsFor('inst-1').find((a) => a.id === created.id);
      expect(updated?.state).toBe('stale');
    });

    it('ignores annotations for a different path or side', () => {
      const forOtherPath = store.add('inst-1', draft({ path: 'y.ts', side: 'new', excerpt: 'line-a\nline-b' }));
      const forOtherSide = store.add('inst-1', draft({ path: 'x.ts', side: 'old', excerpt: 'line-a\nline-b' }));
      store.reconcile('inst-1', 'x.ts', 'new', [{ lineNumber: 1, text: 'irrelevant' }]);
      const list = store.annotationsFor('inst-1');
      expect(list.find((a) => a.id === forOtherPath.id)?.state).toBe('fresh');
      expect(list.find((a) => a.id === forOtherSide.id)?.state).toBe('fresh');
    });

    it('is a no-op when the instance has no draft', () => {
      expect(() => store.reconcile('no-such-instance', 'x.ts', 'new', [])).not.toThrow();
      expect(store.annotationsFor('no-such-instance')).toEqual([]);
    });
  });

  it('_resetForTesting() clears all instances', () => {
    store.add('inst-1', draft());
    store._resetForTesting();
    expect(store.annotationsFor('inst-1')).toEqual([]);
  });
});
