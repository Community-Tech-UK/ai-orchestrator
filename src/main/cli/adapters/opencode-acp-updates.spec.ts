import { describe, expect, it } from 'vitest';
import { OpenCodeAcpUpdates } from './opencode-acp-updates';

describe('OpenCode compaction updates', () => {
  it('finishes a cancelled compaction without marking an unsuccessful compaction as a boundary', () => {
    const updates = new OpenCodeAcpUpdates();
    const started = updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'fixture', status: 'started' }, () => 'row');
    const cancelled = updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'fixture', status: 'cancelled' }, () => 'unused');
    expect(cancelled).toMatchObject({ id: started && started.id, content: 'Compaction cancelled.',
      metadata: { phase: 'cancelled', streaming: false } });
    expect(cancelled && cancelled.metadata).not.toHaveProperty('threadCompacted');
  });

  it('keeps streamed summary text for the completed row, shortened past the display limit', () => {
    const updates = new OpenCodeAcpUpdates();
    updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'fixture', status: 'started' }, () => 'row');
    expect(updates.compaction({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'fixture',
      content: { type: 'text', text: 'Keep the blue theme. ' } }, () => 'unused')).toBe(false);
    updates.compaction({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'fixture',
      content: { type: 'text', text: 'x'.repeat(96_000) } }, () => 'unused');
    const done = updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'fixture', status: 'completed' }, () => 'unused');
    expect(done).toMatchObject({ id: 'row', metadata: { threadCompacted: true, compactionSummaryTruncated: true } });
    expect(String(done && done.metadata?.['compactionSummary'])).toHaveLength(96_000);
    expect(String(done && done.metadata?.['compactionSummary']).startsWith('Keep the blue theme. ')).toBe(true);
  });
});
