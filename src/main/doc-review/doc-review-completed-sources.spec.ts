import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { completedDocumentPath } from './doc-review-completed-sources';

describe('completedDocumentPath', () => {
  it.each([
    ['/w/docs/plans/x_plan.md', '/w/docs/plans/x_plan_completed.md'],
    ['/w/docs/plans/x_spec.md', '/w/docs/plans/x_spec_completed.md'],
    ['/w/docs/plans/x_spec_planned.md', '/w/docs/plans/x_spec_completed.md'],
    ['/w/docs/plans/x_livetest.md', '/w/docs/plans/x_livetest_completed.md'],
    ['/w/docs/plans/decisions-for-james.md', '/w/docs/plans/decisions-for-james_completed.md'],
  ])('maps %s to %s', (source, completed) => {
    expect(completedDocumentPath(join(source))).toBe(join(completed));
  });

  it('returns null for a document that is already completed', () => {
    expect(completedDocumentPath(join('/w/docs/plans/x_plan_completed.md'))).toBeNull();
    expect(completedDocumentPath(join('/w/docs/plans/x_livetest_completed.md'))).toBeNull();
  });
});
