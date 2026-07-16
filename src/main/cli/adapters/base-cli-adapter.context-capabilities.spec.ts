import { describe, expect, it } from 'vitest';
import { ScriptedCliAdapter } from './scripted-cli-adapter';

describe('BaseCliAdapter context-capability contract', () => {
  it('defaults every unproven provider capability conservatively', () => {
    const adapter = new ScriptedCliAdapter();

    expect(adapter.getContextCapabilities()).toEqual({
      toolResultControl: 'none',
      toolResultVisibility: 'none',
      transcriptControl: 'none',
      occupancyReporting: 'none',
      cumulativeReporting: 'none',
      interruptProof: 'none',
      compactionProof: 'none',
      sameThreadContinuation: false,
    });
  });
});
