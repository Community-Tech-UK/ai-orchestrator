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
});
