import { describe, expect, it } from 'vitest';

import { OrchestrationMessageFormatter } from './orchestration-message-formatter';

describe('OrchestrationMessageFormatter', () => {
  const formatter = new OrchestrationMessageFormatter();

  it('formats completed child summaries with conclusions', () => {
    const message = formatter.format('child_completed', 'SUCCESS', {
      childId: 'child-123',
      name: 'Review worker',
      success: true,
      summary: 'Found no blocking issues.',
      conclusions: ['Types are sound', 'Coverage is sufficient'],
    });

    expect(message).toContain('**Child Completed:** Review worker (`child-123`)');
    expect(message).toContain('**Status:** Success');
    expect(message).toContain('Found no blocking issues.');
    expect(message).toContain('- Types are sound');
  });

  it('summarizes active children and consensus queries', () => {
    const message = formatter.format('get_children', 'SUCCESS', {
      children: [
        { id: 'child-a', name: 'Worker A', status: 'busy' },
      ],
      activeConsensusQueries: 1,
    });

    expect(message).toContain('**Active children:**');
    expect(message).toContain('- **Worker A** (`child-a`) - busy');
    expect(message).toContain('**Consensus queries running:** 1');
  });

  describe('all_children_completed (R2C S8)', () => {
    const summaries = [
      { childId: 'c1', name: 'api-audit', summary: 'Found two gaps', success: true },
      { childId: 'c2', name: 'db-audit', summary: 'Timed out', success: false },
    ];

    it('says "All N children completed" when the whole batch finished', () => {
      const message = formatter.format('all_children_completed', 'SUCCESS', {
        totalChildren: 2,
        summaries,
        message: 'All 2 child instances have completed. Their results are in `summaries`, listed once.',
      });

      expect(message).toContain('**All 2 children completed**');
      expect(message).not.toContain('still running');
      expect(message).toContain('- **[SUCCESS]** api-audit: Found two gaps');
      expect(message).toContain('- **[FAILED]** db-audit: Timed out');
      expect(message).toContain('_Synthesis prompt injected to parent CLI._');
    });

    it('does not claim all children finished when other helpers are still running', () => {
      const message = formatter.format('all_children_completed', 'SUCCESS', {
        totalChildren: 2,
        summaries,
        othersStillRunning: true,
        message: 'These 2 helper agents, started together, have completed. Other helper agents are still running. Their results are in `summaries`, listed once.',
      });

      expect(message).toContain('**2 children completed** (other helpers are still running)');
      expect(message).not.toContain('All 2 children completed');
      expect(message).toContain('- **[SUCCESS]** api-audit: Found two gaps');
    });

    it('uses the singular for a partial batch of one', () => {
      const message = formatter.format('all_children_completed', 'SUCCESS', {
        totalChildren: 1,
        summaries: summaries.slice(0, 1),
        othersStillRunning: true,
        message: 'These 1 helper agents, started together, have completed. Other helper agents are still running.',
      });

      expect(message).toContain('**1 child completed** (other helpers are still running)');
    });

    it('lists nothing extra when there are no summaries', () => {
      const message = formatter.format('all_children_completed', 'SUCCESS', { totalChildren: 0 });

      expect(message).toContain('**All 0 children completed**');
    });
  });
});
