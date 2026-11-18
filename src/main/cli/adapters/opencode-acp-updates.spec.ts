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

  it('finishes a pending compaction when the client cancels, once, without waiting for the provider marker', () => {
    const updates = new OpenCodeAcpUpdates();
    const started = updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'pending', status: 'in_progress' }, () => 'row');
    updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'done', status: 'started' }, () => 'finished-row');
    updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'done', status: 'completed' }, () => 'unused');
    const rows = updates.cancelPending();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: started && started.id, content: 'Compaction cancelled.',
      metadata: { phase: 'cancelled', streaming: false } });
    expect(rows[0]?.metadata).not.toHaveProperty('threadCompacted');
    expect(updates.cancelPending()).toEqual([]);
  });

  it('ignores progress that arrives after a compaction was finished', () => {
    const updates = new OpenCodeAcpUpdates();
    updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'pending', status: 'in_progress' }, () => 'row');
    updates.cancelPending();
    expect(updates.compaction({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'pending',
      content: { type: 'text', text: 'late' } }, () => 'unused')).toBe(false);
    expect(updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'pending', status: 'in_progress' }, () => 'unused')).toBe(false);
    // The provider's own cancelled marker still arrives and leaves the row cancelled.
    expect(updates.compaction({ sessionUpdate: 'compaction_update', compactionId: 'pending', status: 'cancelled', summary: null }, () => 'unused'))
      .toMatchObject({ id: 'row', metadata: { phase: 'cancelled', streaming: false } });
  });
});
