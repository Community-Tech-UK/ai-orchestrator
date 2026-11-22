import { describe, expect, it } from 'vitest';
import { FinishedHelpers } from './finished-helpers';

describe('FinishedHelpers', () => {
  it('keeps a leaving helper with its reported cost, and ignores a session with no parent', () => {
    const finished = new FinishedHelpers();
    finished.retain({ id: 'lead', parentId: null, contextUsage: { costEstimate: 5 } });
    finished.retain({ id: 's1', parentId: 'lead', contextUsage: { costEstimate: 0.4 } });
    finished.retain({ id: 's2', parentId: 'lead' });
    expect(finished.list()).toEqual([
      { id: 's1', parentId: 'lead', contextUsage: { costEstimate: 0.4 } },
      { id: 's2', parentId: 'lead', contextUsage: {} },
    ]);
  });

  it('keeps one record per helper', () => {
    const finished = new FinishedHelpers();
    finished.retain({ id: 's1', parentId: 'lead' });
    finished.retain({ id: 's1', parentId: 'lead', contextUsage: { costEstimate: 0.2 } });
    expect(finished.list()).toEqual([{ id: 's1', parentId: 'lead', contextUsage: { costEstimate: 0.2 } }]);
  });

  it('forgets everything below a session that left, and nothing else', () => {
    const finished = new FinishedHelpers();
    finished.retain({ id: 's1', parentId: 'lead' });
    finished.retain({ id: 'grandchild', parentId: 's1' });
    finished.retain({ id: 'other-scout', parentId: 'other-lead' });
    finished.forgetBelow('lead');
    expect(finished.list().map(helper => helper.id)).toEqual(['other-scout']);
  });

  it('says whether a session is a remembered helper', () => {
    const finished = new FinishedHelpers();
    finished.retain({ id: 's1', parentId: 'lead' });
    expect(finished.has('s1')).toBe(true);
    expect(finished.has('lead')).toBe(false);
  });
});
