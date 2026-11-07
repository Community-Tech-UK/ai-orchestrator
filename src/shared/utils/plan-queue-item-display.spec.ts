import { describe, expect, it } from 'vitest';
import { planQueueDocumentLabel } from './plan-queue-item-display';

describe('planQueueDocumentLabel', () => {
  it.each([
    ['/a/b/desk-shared-crm_plan.md', 'desk-shared-crm'],
    ['C:\\a\\desk-colleague-sending_spec.md', 'desk-colleague-sending'],
    ['docs/plans/foo_spec_planned.md', 'foo'], ['docs/plans/foo_livetest.md', 'foo'],
  ])('labels %s without lifecycle suffix', (path, label) => expect(planQueueDocumentLabel(path)).toBe(label));
});
