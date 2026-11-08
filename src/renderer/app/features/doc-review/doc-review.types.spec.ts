import { describe, expect, it } from 'vitest';
import { applyRecommendations } from './doc-review.types';
import type { DocReviewItemInfo, DocReviewItemState } from './doc-review.types';

function state(info: Partial<DocReviewItemInfo>, overrides: Partial<DocReviewItemState> = {}): DocReviewItemState {
  return {
    info: { id: 'item', title: 'Item', decisionId: null, options: [], ...info },
    decision: null,
    comment: '',
    choice: null,
    choices: [],
    ...overrides,
  };
}

describe('applyRecommendations', () => {
  it('approves unanswered sections and picks the recommended option', () => {
    const [plain, single, multi] = applyRecommendations([
      state({ id: 'overview' }),
      state({
        id: 'd1',
        options: [
          { id: 'a', label: 'A', multi: false, isDefault: false },
          { id: 'b', label: 'B', multi: false, isDefault: true },
        ],
      }),
      state({
        id: 'd2',
        options: [
          { id: 'x', label: 'X', multi: true, isDefault: true },
          { id: 'y', label: 'Y', multi: true, isDefault: false },
          { id: 'z', label: 'Z', multi: true, isDefault: true },
        ],
      }),
    ]);

    expect(plain).toMatchObject({ decision: 'approve', choice: null, choices: [] });
    expect(single).toMatchObject({ decision: 'approve', choice: 'b', choices: [] });
    expect(multi).toMatchObject({ decision: 'approve', choice: null, choices: ['x', 'z'] });
  });

  it('keeps the reviewer\'s own answers', () => {
    const options = [
      { id: 'a', label: 'A', multi: false, isDefault: true },
      { id: 'b', label: 'B', multi: false, isDefault: false },
    ];
    const rejected = state({ id: 'r', options }, { decision: 'reject', comment: 'no' });
    const [keptReject, keptChoice, noRecommendation] = applyRecommendations([
      rejected,
      state({ id: 'c', options }, { choice: 'b', comment: 'prefer b' }),
      state({ id: 'n', options: [{ id: 'a', label: 'A', multi: false, isDefault: false }] }),
    ]);

    expect(keptReject).toBe(rejected);
    expect(keptChoice).toMatchObject({ decision: 'approve', choice: 'b', comment: 'prefer b' });
    expect(noRecommendation).toMatchObject({ decision: 'approve', choice: null, choices: [] });
  });
});
